# Automation Setup Guide (launchd)

Gnosis では、macOS の `launchd` を使用して、バックグラウンドでの知識収集、ログ同期、自己省察などを自動化するための設定ファイル（plist）を提供しています。

## 自動化タスク一覧

| plist 名 | 役割 | 実行タイミング |
| :--- | :--- | :--- |
| `com.gnosis.worker.plist` | KnowFlow ワーカー | 常駐 (KeepAlive) |
| `com.gnosis.sync.plist` | 外部ログ同期 (`sync_agent_logs`) | 1時間ごと |
| `com.gnosis.reflect.plist` | 自己省察 (`reflect_on_memories`) | 1日1回 |
| `com.gnosis.guidance.plist` | ガイダンスインポート | 1時間ごと |
| `com.gnosis.report.plist` | システムステータス通知 | 1日1回 |

---

## セットアップ手順

これらの plist ファイルには `{{BUN_PATH}}` や `{{PROJECT_ROOT}}` といったプレースホルダが含まれています。使用前にこれらを環境に合わせて置換する必要があります。

### 1. プレースホルダの置換

プロジェクトルートで以下のコマンドを実行し、実際のパスを反映させた plist を生成します（手動またはスクリプト実行）。

```bash
# 例: worker の設定
sed -e "s|{{BUN_PATH}}|$(which bun)|g" \
    -e "s|{{PROJECT_ROOT}}|$PWD|g" \
    scripts/automation/com.gnosis.worker.plist > ~/Library/LaunchAgents/com.gnosis.worker.plist
```

### 2. ジョブのロード

```bash
launchctl load ~/Library/LaunchAgents/com.gnosis.worker.plist
```

### 3. 状態の確認

```bash
launchctl list | grep gnosis
```

ログは `{{PROJECT_ROOT}}/logs/` 内の各ファイル（例: `worker.log`）に出力されます。

---

## 注意事項

-   **パスの権限**: `WorkingDirectory` への書き込み権限が必要です。
-   **環境変数**: `.env` ファイルに記述された環境変数は、Bun が実行される際に自動的に読み込まれますが、絶対パスで指定されていることを確認してください。
-   **停止方法**:
    ```bash
    launchctl unload ~/Library/LaunchAgents/com.gnosis.worker.plist
    ```
