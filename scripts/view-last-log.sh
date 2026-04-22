#!/usr/bin/env bash

LOG_DIR="logs/runs"

if [ ! -d "$LOG_DIR" ]; then
    echo "Log directory not found: $LOG_DIR"
    exit 1
fi

LATEST_LOG=$(ls -t "$LOG_DIR"/*.jsonl 2>/dev/null | head -n 1)

if [ -z "$LATEST_LOG" ]; then
    echo "No log files found in $LOG_DIR"
    exit 1
fi

echo "Viewing latest log: $LATEST_LOG"
echo "--------------------------------------------------"

if command -v jq &> /dev/null; then
    cat "$LATEST_LOG" | jq -r '(.ts + " [" + .level + "] " + .event + (if .data then " " + (.data|to_json) else "" else ""))' 2>/dev/null || cat "$LATEST_LOG"
else
    cat "$LATEST_LOG"
fi
