# MCP Tools API Reference

Gnosis は、エージェントが長期記憶、知識グラフ、自律調査能力を利用するための 18 の MCP ツールを提供します。

## ツールカテゴリ一覧

- [Memory](#memory): セマンティック検索可能な長期記憶
- [Graph](#graph): 構造化された知識グラフ
- [Knowledge](#knowledge): 検証済み知識の検索
- [KnowFlow](#knowflow): 自律的な知識収集タスク
- [Experience](#experience): 過去の失敗からの学習
- [Sync & Reflection](#sync--reflection): 外部ログ同期と自己省察
- [Guidance](#guidance): 命令・規約の登録

---

## Memory

### `store_memory`
- **用途**: 観察、設計判断、TODO、レビュー指摘事項など、後で参照したいあらゆるテキスト情報を保存します。
- **入力**: 
  - `sessionId` (string, 必須): プロジェクトやコンテキストを分離するための識別子。
  - `content` (string, 必須): 保存するテキスト。
  - `metadata` (object, 任意): 任意の追加データ。
  - `entities` (array, 任意): 保存内容に含まれるエンティティ情報。
  - `relations` (array, 任意): エンティティ間の関係性。
- **出力**: `Memory stored successfully with ID: <uuid>`

### `search_memory`
- **用途**: セマンティック検索（意味的な類似度）により、保存されたメモリを検索します。
- **入力**: 
  - `sessionId` (string, 必須): 検索対象のセッション。
  - `query` (string, 必須): 検索クエリ。
  - `limit` (number, 任意, デフォルト: 5): 最大取得件数。
  - `filter` (object, 任意): メタデータによるフィルタリング。
- **出力**: メモリの配列（ID, content, similarity などを含む JSON）。

### `delete_memory`
- **用途**: 指定した ID のメモリを物理削除します。
- **入力**: 
  - `memoryId` (string, 必須): 削除対象の UUID。

---

## Graph

### `query_graph`
- **用途**: 指定したキーワードまたは ID を起点に、ナレッジグラフから最大 2 ホップ先の関連情報を取得します（Graph RAG）。
- **入力**: 
  - `query` (string, 必須): 起点となるエンティティの名前または ID。
- **出力**: ノードとエッジのリスト（JSON）。

### `digest_text`
- **用途**: 入力テキストを解析し、既存のグラフ内に存在する関連エンティティを特定・提案します。
- **入力**: 
  - `text` (string, 必須): 解析対象のテキスト。
  - `limit` (number, 任意, デフォルト: 5): 提案数。

### `update_graph`
- **用途**: エンティティ情報の修正、またはリレーションの削除を行います。
- **入力**: 
  - `action` (enum, 必須): `update_entity` または `delete_relation`。
  - `entity` / `relation` (object): アクションに応じた詳細情報。

### `find_path`
- **用途**: 2 つのエンティティ間を繋ぐ最短経路を探索し、それらの関係性を明らかにします。
- **入力**: 
  - `queryA`, `queryB` (string, 必須): 始点と終点のエンティティ名。

### `build_communities`
- **用途**: グラフ全体のトポロジーを分析し、密接に関連するノードのグループ（コミュニティ）を検出・要約します。
- **入力**: なし。

---

## Knowledge

### `search_knowledge`
- **用途**: KnowFlow が収集・検証した「確定した事実（クレーム）」を全文検索 (FTS) します。
- **入力**: 
  - `query` (string, 必須): 検索クエリ。
- **出力**: 関連するクレームのリストと信頼度。

### `get_knowledge`
- **用途**: 特定のトピックに関する詳細情報（すべてのクレーム、関連トピック、情報源 URL）をまとめて取得します。
- **入力**: 
  - `topic` (string, 必須): トピック名。

### `search_unified`
- **用途**: `fts` (全文検索), `kg` (グラフ探索), `semantic` (メモリ検索) の 3 つのモードを使い分けて横断検索します。
- **入力**: 
  - `query` (string, 必須): 検索クエリ。
  - `mode` (enum, 必須): `fts`, `kg`, `semantic`。

---

## KnowFlow

### `enqueue_knowledge_task`
- **用途**: 指定したトピックについて、ウェブ検索と LLM による詳細な調査をタスクキューに投入します。
- **入力**: 
  - `topic` (string, 必須): 調査対象。
  - `mode` (enum, 任意): `directed` (直接), `expand` (拡張), `explore` (探索)。
  - `priority` (number, 任意): 優先度。

### `run_knowledge_worker`
- **用途**: キューに滞留しているタスクを 1 件取り出して実行します。
- **入力**: 
  - `maxAttempts` (number, 任意): リトライ回数。

---

## Experience

### `record_experience`
- **用途**: 開発中の失敗（エラー、拒絶されたパッチ）と、それに対する成功（解決策）をセットで記録します。
- **入力**: 
  - `sessionId`, `scenarioId`, `attempt`, `type`, `content`, `metadata`.

### `recall_lessons`
- **用途**: 現在発生している問題に類似した過去の「教訓」を検索し、解決のヒントを得ます。
- **入力**: 
  - `sessionId`, `query`.

---

## Sync & Reflection

### `sync_agent_logs`
- **用途**: Claude Code や Antigravity の会話ログを解析し、未発見の知見を自動的に Vibe Memory へ同期します。
- **入力**: なし（設定されたディレクトリをスキャン）。

### `reflect_on_memories`
- **用途**: まだ構造化されていない Vibe Memory を分析し、エンティティとリレーションを抽出して Knowledge Graph へ統合します。
- **入力**: なし。

---

## Guidance

### `register_guidance`
- **用途**: プロジェクト固有の規約 (rule) や手順 (skill) を登録します。これらはエージェントのプロンプト構築時に自動的に参照されます。
- **入力**: 
  - `title`, `content`, `guidanceType` (`rule` or `skill`), `scope`.

---

## 使い分けガイド

- **「ちょっとしたメモや一時的な知見」** → `store_memory`
- **「公式な規約や絶対守るべきルール」** → `register_guidance`
- **「特定のトピックについて徹底的に調べさせたい」** → `enqueue_knowledge_task`
- **「過去に同じエラーでハマっていないか調べたい」** → `recall_lessons`
- **「A という概念と B という概念がどう繋がっているか知りたい」** → `find_path` または `query_graph`
