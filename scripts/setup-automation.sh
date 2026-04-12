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

# ログディレクトリの作成
mkdir -p "$PROJECT_ROOT/logs"

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
    for plist in "$SYNC_PLIST" "$REFLECT_PLIST" "$WORKER_PLIST" "$GUIDANCE_PLIST" "$REPORT_PLIST"; do
        sed "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g; s|{{BUN_PATH}}|$BUN_PATH|g" "$PLIST_DIR/$plist" > "$LAUNCH_AGENTS_DIR/$plist"
    done
    
    # 権限の確認
    chmod 644 "$LAUNCH_AGENTS_DIR/$SYNC_PLIST"
    chmod 644 "$LAUNCH_AGENTS_DIR/$REFLECT_PLIST"
    chmod 644 "$LAUNCH_AGENTS_DIR/$WORKER_PLIST"
    chmod 644 "$LAUNCH_AGENTS_DIR/$GUIDANCE_PLIST"
    chmod 644 "$LAUNCH_AGENTS_DIR/$REPORT_PLIST"
    
    echo "Done. Files copied to $LAUNCH_AGENTS_DIR."
    echo "To start the jobs, run: $0 load"
}

function load() {
    echo "Loading Gnosis jobs into launchctl..."
    launchctl load "$LAUNCH_AGENTS_DIR/$SYNC_PLIST"
    launchctl load "$LAUNCH_AGENTS_DIR/$REFLECT_PLIST"
    launchctl load "$LAUNCH_AGENTS_DIR/$WORKER_PLIST"
    launchctl load "$LAUNCH_AGENTS_DIR/$GUIDANCE_PLIST"
    launchctl load "$LAUNCH_AGENTS_DIR/$REPORT_PLIST"
    echo "Jobs loaded."
}

function unload() {
    echo "Unloading Gnosis jobs from launchctl..."
    launchctl unload "$LAUNCH_AGENTS_DIR/$SYNC_PLIST"
    launchctl unload "$LAUNCH_AGENTS_DIR/$REFLECT_PLIST"
    launchctl unload "$LAUNCH_AGENTS_DIR/$WORKER_PLIST"
    launchctl unload "$LAUNCH_AGENTS_DIR/$GUIDANCE_PLIST"
    launchctl unload "$LAUNCH_AGENTS_DIR/$REPORT_PLIST"
    echo "Jobs unloaded."
}

function uninstall() {
    echo "Uninstalling Gnosis LaunchAgents..."
    unload
    rm "$LAUNCH_AGENTS_DIR/$SYNC_PLIST"
    rm "$LAUNCH_AGENTS_DIR/$REFLECT_PLIST"
    rm "$LAUNCH_AGENTS_DIR/$WORKER_PLIST"
    rm "$LAUNCH_AGENTS_DIR/$GUIDANCE_PLIST"
    rm "$LAUNCH_AGENTS_DIR/$REPORT_PLIST"
    echo "Files removed."
}

function status() {
    echo "Status of Gnosis jobs:"
    launchctl list | grep com.gnosis
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
