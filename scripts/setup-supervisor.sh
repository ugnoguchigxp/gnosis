#!/bin/bash

# Gnosis Supervisor LaunchAgent Setup Script
# macOS ログイン時に自動的に Supervisor を起動するように設定します。

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_NAME="com.gnosis.supervisor"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_NAME}.plist"
BUN_PATH="$(which bun)"

if [ -z "$BUN_PATH" ]; then
    echo "Error: bun is not installed or not in PATH."
    exit 1
fi

echo "Creating LaunchAgent configuration..."

cat <<EOF > "${PLIST_PATH}"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BUN_PATH}</string>
        <string>run</string>
        <string>${PROJECT_ROOT}/src/supervisor/daemon.ts</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>
    <key>StandardOutPath</key>
    <string>${PROJECT_ROOT}/.gnosis/supervisor.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_ROOT}/.gnosis/supervisor.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH}</string>
        <key>GNOSIS_SUPERVISOR_AUTO_KILL</key>
        <string>true</string>
    </dict>
</dict>
</plist>
EOF

echo "Registering LaunchAgent..."
launchctl unload "${PLIST_PATH}" 2>/dev/null || true
launchctl load "${PLIST_PATH}"

echo "--------------------------------------------------"
echo "Success! Gnosis Supervisor is now automated."
echo "Status: Running in background"
echo "Log: ${PROJECT_ROOT}/.gnosis/supervisor.log"
echo "--------------------------------------------------"
