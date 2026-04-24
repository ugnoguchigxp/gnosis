# Gnosis クリーンアップチェックリスト (Agent OS 移行版) [Completed]

Serena 機能の TypeScript 移植および Agent OS への進化に伴い、不要になった旧実装と除外された方針の整理が完了しました。

## 背景

当初検討されていた「Review Agent 専念方針」および「旧 Python 主導のコーディング機能」を整理し、TypeScript 主導のシンボル解析基盤へと移行しました。Serena の「読み込み・シンボル構造解析」機能は維持（読み取り専用化）し、自律的な「編集・作成・削除」機能は計画通り排除しました。

---

## 1. 完了したタスク

### 1.1 旧方針ドキュメントの削除 [Done]

- [x] `docs/spec-agent.md` の削除
- [x] `docs/coding-agent.md` の削除

### 1.2 Semantic Code MCP Server のリファクタリング [Done]

- [x] `src/scripts/semanticCodeMcpServer.ts` から書き込みツール (`create_file`, `replace_content` 等) を削除
- [x] 読み取り専用（シンボル探索・参照・構造把握）ツールとして再定義
- [x] 関連するテストケースの整理

### 1.3 Python local-llm の修正 [Done]

- [x] `services/local-llm/main.py` から `coding_agent_instruction` を削除
- [x] `qwen` バックエンドの追加とデフォルトモデルの設定
- [x] Markdown 関連パッケージの依存確認（不要な外部依存がないことを確認済み）

### 1.4 Tauri Monitor UI の整理 [Done]

- [x] **Agent ページの削除**:
  - [x] `apps/monitor/src/routes/+layout.svelte` からのリンク削除
  - [x] `apps/monitor/src/routes/agent/` ディレクトリの削除
- [x] **Tauri バックエンドのクリーンアップ**:
  - [x] `src-tauri/src/lib.rs` からの `monitor_agent_chat` ハンドラ削除
  - [x] `src-tauri/src/monitor/commands.rs` からのコマンド定義削除
  - [x] `src-tauri/src/monitor/cli.rs` からの `run_agent_chat` および付随するファイル適用ロジック (`apply_markdown_file_blocks`) の削除

---

## 2. 最終確認結果

| 項目 | ステータス | 備考 |
|------|------------|------|
| 旧 `monitor_agent_chat` コマンド | 削除済み | Rust バックエンドから完全に排除 |
| 旧 `run_agent_chat` 関数 | 削除済み | 危険なファイル書き出しロジックと共に排除 |
| `semanticCodeMcpServer.ts` | 存続 (Refactored) | 読み取り専用ツールとして Agent OS 基盤に統合 |
| Markdown パッケージ | 確認済み | プロジェクト内に `marked` 等の外部依存なし |

---

## 3. 将来の検討事項

- `semantic_list_files`, `semantic_read_file` 等の読み取り専用ツールを `src/mcp/tools/semantic.ts` としてさらに整理・独立させる
- Agent OS としての新しい統合 UI の構築
- シンボルベースの安全な自動編集（検証・承認フロー付き）の再設計

---

Document Version: 1.1.0 (Final)
Last Updated: 2025-04-24
Status: **COMPLETED**
Author: Gnosis Development Team
