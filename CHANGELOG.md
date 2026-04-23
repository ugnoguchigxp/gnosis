# CHANGELOG

すべての重要な変更をこのファイルに記録します。

## [0.2.0] - 2026-04-23

### Added
- **Gnosis Hook システム (v1)**: イベント駆動型の自動化エンジンを導入。ファイル変更やタスク完了をトリガーに品質ゲート（lint, test, review）を自動実行。
- **Candidate Queue**: 経験（episode/lesson）を即座に永続化せず、まず候補としてキューイングし、バックグラウンドで昇格させるフローを構築。
- **非同期ツールセット**: `store_memory` や `record_experience` などの重い処理を非同期化。エージェント側の待機時間を大幅に短縮。
- **リサーチ・コマンド**: `test:related` コマンドを追加し、変更内容に関連するテストのみを効率的に実行可能に。

### Improved
- **プロセス・レジリエンス**: PIDファイルによる二重起動防止、SIGINT/SIGTERMの確実な捕捉、およびクリーンアップ用ウォッチドッグの実装。
- **グローバルセマフォの堅牢化**: 異常終了したプロセスの古いロックファイルを自動検知・修復するロジックを強化。
- **DB設計の最適化**: `hook_executions`, `hook_candidates` テーブルを追加し、実行の冪等性を担保。

## [0.1.0] - 2026-04-13

### Added
- **MCP Server 分割**: `server.ts` を機能別のツールファイル (`tools/*.ts`) に分割し、保守性を向上。
- **KnowFlow 統合**: 自律的な調査・知識収集エンジン KnowFlow をコアへ統合。
- **Failure Learning Loop**: 過去の失敗から教訓を検索し、再発を防止する経験学習機能を実装。
- **Guidance Registry**: プロジェクト固有のルール・手順を管理し、エージェントへ注入する仕組みを構築。
- **Monitor UI**: Tauri + SvelteKit によるリアルタイム監視デスクトップアプリのプロトタイプを実装。
- **ドキュメント整備**: README の全面改訂に加え、API リファレンス、アーキテクチャ、設定、運用ガイドを新規作成。

---

[0.1.0]: https://github.com/ugnoguchigxp/gnosis/releases/tag/v0.1.0
