# KnowFlow: KG/全文検索 一体運用 実装計画

## 1. 目的

KnowFlow の知識登録と検索を次の運用で固定する。

- Knowledge Graph 登録判定 = 全文検索登録判定
- Raw データは保持しない
- 有意義と判定されたデータのみ `knowledge_*` テーブルに保存
- `knowledge_claims` を全文検索の単一インデックス面として利用

この計画は「ローカル実行・CLI/MCP中心・UI不要」の前提で作成する。

## 2. スコープ

実施対象:

1. `knowledge_claims` 向け PostgreSQL 標準 FTS インデックス整備
2. `search_knowledge` の検索ロジックを FTS 中心に最適化
3. MCP/CLI からの検索利用方針を一体運用として明文化
4. 登録ルール（有意義判定）をドキュメント化し、実装と一致させる
5. テストとローカル検証コマンドを追加

非対象:

- Raw 本文保管テーブルの追加
- freshness 再評価パイプラインの導入
- 常駐サーバー/UIの追加
- PGroonga 前提の実装

## 3. データ登録ルール（固定）

1. KnowFlow の検証フェーズで「登録可」となった知識だけを保存する。
2. 保存先は現行の `knowledge_topics / knowledge_claims / knowledge_relations / knowledge_sources` のみ。
3. `knowledge_claims.text` は Knowledge Graph のクレーム本体であり、同時に全文検索対象でもある。
4. Raw 取得本文や中間スクレイプ結果は永続化しない。

## 4. 実装ステップ

### Step 1: スキーマ/マイグレーション

- `knowledge_claims` に PostgreSQL 標準 FTS 用 GIN インデックスを追加する。
- 想定 SQL（例）:
  - `to_tsvector('simple', coalesce(text, ''))` への GIN index
- 必要に応じて補助インデックス（`confidence`, `updated_at`）を見直す。

完了条件:

- マイグレーション適用後に `EXPLAIN` で FTS クエリが GIN インデックスを利用する。

### Step 2: 検索クエリ刷新（`src/services/knowledge.ts`）

- `searchKnowledgeClaims` を FTS 優先へ変更する。
- 基本方針:
  - まず `websearch_to_tsquery`（または `plainto_tsquery`）で検索
  - `ts_rank_cd` でスコア順
  - ヒット0件時のみ LIKE フォールバック
- 返却値に `score` を追加し、MCP/CLI で観測できるようにする。

完了条件:

- 既存 API 互換を維持しつつ、結果の順位付けが説明可能になる。

### Step 3: MCP/CLI 利用ルール反映

- `search_knowledge` ツール説明を「`knowledge_claims` の全文検索」で統一。
- CLI (`search-knowledge`) のヘルプ文言を同一方針に更新。
- 自動ハイブリッドの実装は行わず、MCP 側の判断で `query_graph` と `search_knowledge` を使い分ける前提を明記。

使い分けの目安（ドキュメント定義）:

- エンティティ間の関係・近傍探索をしたい: `query_graph`
- トピック横断でクレーム本文を探したい: `search_knowledge`
- 判断不能な場合: MCP が両方実行し、LLM が統合判断

完了条件:

- README/MCP description/CLI help に矛盾がない。

### Step 4: 登録有意義性の実装ルール固定

- 登録条件をコードコメントとドキュメントで固定する。
- 最低限の判定項目:
  - `claim.text` が空でない
  - `confidence` が閾値以上
  - `sourceIds` が空でない（例外を作る場合は明示）
  - 既存クレーム重複は fingerprint/similarity でマージ

完了条件:

- 「何が保存されるか」が実装・README・計画書で一致する。

### Step 5: テスト追加

- 検索:
  - FTS ヒット
  - ヒット0時の LIKE フォールバック
  - スコア順ソート
- 登録:
  - 重複クレーム統合
  - 低品質入力の除外（閾値未満）
- 回帰:
  - `bun test` / `bun run verify` が通る

## 5. ロールアウト順

1. マイグレーション追加
2. 検索コード差し替え
3. MCP/CLI 文言更新
4. テスト追加
5. README 更新
6. ローカルで `verify` 実行

## 6. 受け入れ基準

- 登録判定が KG と全文検索で完全一致している（別経路登録なし）
- Raw 本文が DB に保存されない
- `search_knowledge` が FTS 優先で動作し、最低限のフォールバックを持つ
- 主要ドキュメント（README/本計画書/MCP説明）に矛盾がない
- ローカル品質ゲート (`bun run verify`) が成功する

## 7. 留意点

- 標準 FTS の辞書はまず `simple` で開始し、英語中心の検索品質を優先する。
- 日本語検索品質が不足する場合のみ、後続で PGroonga を追加検討する（初期スコープ外）。
