# CHANGELOG

すべての重要な変更をこのファイルに記録します。

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
