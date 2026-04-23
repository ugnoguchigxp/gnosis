# Gnosis Hook 設定・運用ガイド

Gnosis Hook は、AI エージェントの作業の「節目（Checkpoint）」や「ファイル変更」をトリガーに、自動的に品質検証、リスク検知、記憶候補の作成を行う自律型オートメーション・システムです。

---

## 1. クイックスタート

### 1.1 セットアップ
プロジェクトを初期化した後、以下のコマンドを実行して Hook ルールとエージェント向け命令を環境へ配布します。

```bash
bun run hooks:setup
```

このコマンドは以下の処理を行います。
- `.cursorrules`, `.clauderules`, `.ai-rules.md` 等に Hook 利用の命令を自動挿入
- `~/.gnosis/hooks/manual.md` にグローバルマニュアルを生成

### 1.2 有効化
`.env` ファイルで Hook 機能が有効になっていることを確認してください。

```env
GNOSIS_HOOKS_ENABLED=true
```

---

## 2. 核心コンセプト：イベント駆動型オートメーション

Hook は、IDE やエージェントが発火させる **イベント** を検知し、YAML で定義された **ルール** に基づいて **アクション** を実行します。

### 主要イベント
- **`task.segment.completed`**: 実装の「一区切り」がついたタイミング（`task_checkpoint` ツールで発火）。
- **`task.ready_for_review`**: レビューを依頼する直前のタイミング。
- **`file.changed`**: ファイルが保存されたタイミング（自動デバウンス機能付き）。
- **`task.completed` / `task.failed`**: タスクが成功または失敗で終了したタイミング。
- **`review.completed`**: AI によるコードレビューが完了したタイミング。

---

## 3. ルールの定義方法

ルールは `src/hooks/rules/` ディレクトリ内に YAML 形式で定義します。

### 定義例 (`segment-lint.yaml`)
```yaml
id: segment-lint-typescript
event: task.segment.completed
priority: 100
conditions:
  project_type: typescript
  changed_files_min: 1
actions:
  - type: run_command
    command: bun run lint
    timeout_sec: 60
on_failure:
  strategy: block_with_guidance
  guidance: |
    Lint エラーが検出されました。修正してから次のセグメントに進んでください。
```

### 失敗時の戦略 (`on_failure.strategy`)
- `ignore`: エラーを無視して続行します。
- `soft_warn`: 警告を表示しますが、進行は妨げません。
- `block_with_guidance`: ガイダンスを表示し、エージェントに修正を促します（MCP ツールがエラーを返します）。
- `block_progress`: 進行を厳格にブロックします。

---

## 4. エージェント（LLM）への運用指示

エージェント（Cursor, Claude Code 等）は、以下のタイミングで `task_checkpoint` ツールを呼び出すように指示されています。

1. **セグメント完了時**: 「関数を一つ書き終えた」「リファクタリングの第一段階が終わった」などの区切りで呼び出し、自動検証（Lint/Test）を受けます。
2. **レビュー依頼前**: レビューを依頼する前に呼び出し、最終的な品質ゲートをパスすることを確認します。
3. **タスク終了時**: タスクの成功/失敗を報告し、エピソード記憶への昇格候補を作成します。

---

## 5. Candidate Queue（記憶の昇格待ち）

Hook によって作成されたエピソードや教訓は、即座にデータベースへ保存されるのではなく、まず **Candidate（候補）** として `hook_candidates` テーブルに積まれます。

これにより：
- ノイズの多い短期的なメモの混入を防止
- バックグラウンドワーカーによる重複排除とスコアリング
- 重要な知見のみを高品質な長期記憶へ昇華

が可能になります。

---

## 6. トラブルシューティング

### Hook が発火しない
- `GNOSIS_HOOKS_ENABLED=true` になっているか確認してください。
- `bun run start` でサーバーを起動し、起動ログに `[Hooks] Loaded X rules` と表示されているか確認してください。

### 特定のファイルを無視したい
YAML ルールの `conditions` に `path_matches` や `path_excludes`（将来拡張）を設定することで制御可能です。

### 実行が遅い
`run_command` アクションには必ず `timeout_sec` が適用されます。デフォルトでは 120 秒です。タイムアウトが発生した場合は、`HOOK_ACTION_TIMEOUT` エラーが記録されます。
