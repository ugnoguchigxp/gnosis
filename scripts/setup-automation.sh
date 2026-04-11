#!/bin/bash

# Gnosis Automation Setup Script
# macOS LaunchAgents の登録・解除を管理します。

PROJECT_ROOT="/Users/y.noguchi/Code/gnosis"
PLIST_DIR="$PROJECT_ROOT/scripts/automation"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

SYNC_PLIST="com.gnosis.sync.plist"
REFLECT_PLIST="com.gnosis.reflect.plist"

# ログディレクトリの作成
mkdir -p "$PROJECT_ROOT/logs"

function install() {
    echo "Installing Gnosis LaunchAgents..."
    
    # ファイルをコピー
    cp "$PLIST_DIR/$SYNC_PLIST" "$LAUNCH_AGENTS_DIR/"
    cp "$PLIST_DIR/$REFLECT_PLIST" "$LAUNCH_AGENTS_DIR/"
    
    # 権限の確認
    chmod 644 "$LAUNCH_AGENTS_DIR/$SYNC_PLIST"
    chmod 644 "$LAUNCH_AGENTS_DIR/$REFLECT_PLIST"
    
    echo "Done. Files copied to $LAUNCH_AGENTS_DIR."
    echo "To start the jobs, run: $0 load"
}

function load() {
    echo "Loading Gnosis jobs into launchctl..."
    launchctl load "$LAUNCH_AGENTS_DIR/$SYNC_PLIST"
    launchctl load "$LAUNCH_AGENTS_DIR/$REFLECT_PLIST"
    echo "Jobs loaded."
}

function unload() {
    echo "Unloading Gnosis jobs from launchctl..."
    launchctl unload "$LAUNCH_AGENTS_DIR/$SYNC_PLIST"
    launchctl unload "$LAUNCH_AGENTS_DIR/$REFLECT_PLIST"
    echo "Jobs unloaded."
}

function uninstall() {
    echo "Uninstalling Gnosis LaunchAgents..."
    unload
    rm "$LAUNCH_AGENTS_DIR/$SYNC_PLIST"
    rm "$LAUNCH_AGENTS_DIR/$REFLECT_PLIST"
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
