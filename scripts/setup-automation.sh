#!/bin/bash

# Gnosis Automation Setup Script
# macOS LaunchAgents の登録・解除を管理します。

# プロジェクトのルートディレクトリを動的に取得
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
PROJECT_ROOT="$( cd -P "$( dirname "$SOURCE" )/.." && pwd )"
PLIST_DIR="$PROJECT_ROOT/scripts/automation"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

SYNC_PLIST="com.gnosis.sync.plist"
REFLECT_PLIST="com.gnosis.reflect.plist"
WORKER_PLIST="com.gnosis.worker.plist"
GUIDANCE_PLIST="com.gnosis.guidance.plist"
REPORT_PLIST="com.gnosis.report.plist"
WATCHDOG_PLIST="com.gnosis.process-watchdog.plist"
MCP_HOST_PLIST="com.gnosis.mcp-host.plist"
PLISTS=("$SYNC_PLIST" "$REFLECT_PLIST" "$WORKER_PLIST" "$GUIDANCE_PLIST" "$REPORT_PLIST" "$WATCHDOG_PLIST" "$MCP_HOST_PLIST")

# ログディレクトリの作成
mkdir -p "$PROJECT_ROOT/logs"
mkdir -p "$LAUNCH_AGENTS_DIR"

function install() {
    echo "Installing Gnosis LaunchAgents..."
    
    # Bunのパスをもとめる
    BUN_PATH=$(which bun)
    if [ -z "$BUN_PATH" ]; then
        BUN_PATH="$HOME/.bun/bin/bun"
    fi
    echo "Using BUN_PATH: $BUN_PATH"
    echo "Using PROJECT_ROOT: $PROJECT_ROOT"

    # ファイルをコピーしてプレースホルダーを置換
    for plist in "${PLISTS[@]}"; do
        sed "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g; s|{{BUN_PATH}}|$BUN_PATH|g" "$PLIST_DIR/$plist" > "$LAUNCH_AGENTS_DIR/$plist"
    done
    
    # 権限の確認
    for plist in "${PLISTS[@]}"; do
        chmod 644 "$LAUNCH_AGENTS_DIR/$plist"
    done
    
    echo "Done. Files copied to $LAUNCH_AGENTS_DIR."
    echo "To start the jobs, run: $0 load"
}

function load() {
    echo "Loading Gnosis jobs into launchctl..."
    for plist in "${PLISTS[@]}"; do
        launchctl load "$LAUNCH_AGENTS_DIR/$plist"
    done
    echo "Jobs loaded."
}

function unload() {
    echo "Unloading Gnosis jobs from launchctl..."
    for plist in "${PLISTS[@]}"; do
        launchctl unload "$LAUNCH_AGENTS_DIR/$plist" 2>/dev/null || true
    done
    echo "Jobs unloaded."
}

function uninstall() {
    echo "Uninstalling Gnosis LaunchAgents..."
    unload
    for plist in "${PLISTS[@]}"; do
        rm -f "$LAUNCH_AGENTS_DIR/$plist"
    done
    echo "Files removed."
}

function status() {
    echo "Status of Gnosis jobs:"
    for plist in "${PLISTS[@]}"; do
        label="${plist%.plist}"
        target="$LAUNCH_AGENTS_DIR/$plist"
        echo "--- $label ---"
        if [ ! -f "$target" ]; then
            echo "not installed"
            continue
        fi
        if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
            launchctl print "gui/$UID/$label" | grep -E "state =|last exit code|pid =|path =|program =|program arguments =" || true
        else
            echo "not loaded"
        fi
    done
}



case "$1" in
    install)
        install
        ;;
    load)
        load
        ;;
    unload)
        unload
        ;;
    uninstall)
        uninstall
        ;;
    status)
        status
        ;;
    *)
        echo "Usage: $0 {install|load|unload|uninstall|status}"
        exit 1
esac
