# MCP Tools API Reference

Gnosis は、エージェントが長期記憶、知識グラフ、自律調査能力、計画レビューを利用するための MCP ツール群を提供します。
現在は **Agent-First** ワークフローを推奨しており、主要な 8 つのツールのみが公開されています。

## 公開ツール一覧 (Agent-First)

推奨される一次導線（初期化・タスク開始・知識検索・レビュー・完了）を構成するツール群です。

- [initial_instructions](#initial_instructions): 推奨ワークフローと first-call の確認
- [activate_project](#activate_project): プロジェクト状態の初期化とヘルスチェック
- [search_knowledge](#search_knowledge): 知識のセマンティック検索
- [start_task](#start_task): タスク実行の記録開始
- [record_task_note](#record_task_note): 作業中の知見や教訓の保存
- [finish_task](#finish_task): タスク完了と学習項目の確定
- [review_task](#review_task): 知識注入型レビューの実行
- [doctor](#doctor): ランタイム診断とメタデータ整合性チェック

---

## Agent-First Tools

### `initial_instructions`
- **用途**: 新規セッションの最初に呼び、推奨ワークフローと first-call を確認します。
- **出力**: `firstCall=activate_project` を含むガイド JSON。
- **重要**: レビュー開始前にも再実行し、シナリオごとの手順を確認してください。

### `activate_project`
- **用途**: プロジェクト状態を初期化し、ヘルス、オンボーディング状態、知識インデックスの要約を取得します。
- **入力**:
  - `projectRoot` (string, 任意): プロジェクトのルートパス
  - `mode` (`planning|editing|review|onboarding|no_memory`, 任意): 作業モード

### `search_knowledge`
- **用途**: 知識（ルール、手順、教訓、リスク等）を検索します。
- **入力**:
  - `query` (string, 任意): 検索クエリ
  - `preset` (`task_context|project_characteristics|review_context|procedures|risks`, 任意): 検索プリセット
  - `kinds`, `categories`, `filters`, `grouping`, `traversal` 等（任意）

### `start_task`
- **用途**: タスクのトレースを開始し、`taskId` を取得します。
- **入力**:
  - `title` (string, 必須): タスクのタイトル
  - `intent`, `files`, `projectRoot`, `taskId` (任意)

### `record_task_note`
- **用途**: 作業中に得られた再利用可能な知見（教訓、観察、決定事項）を保存します。
- **入力**:
  - `content` (string, 必須): 知見の内容
  - `kind`, `category`, `title`, `purpose`, `tags`, `files`, `evidence` (任意)

### `finish_task`
- **用途**: タスクを完了し、成果、チェック項目、次のアクション、学習した項目を確定します。
- **入力**:
  - `taskId` (string, 必須): 完了するタスクの ID
  - `outcome` (string, 必須): タスクの成果
  - `checks`, `followUps`, `learnedItems` (任意)

### `review_task`
- **用途**: コード、ドキュメント、実装計画、仕様書等のレビューを実行します。ナレッジグラフからの知識注入を自動的に行います。
- **入力**:
  - `targetType` (`code_diff|document|implementation_plan|spec|design`, 必須)
  - `target` (object, 必須): `diff`, `filePaths`, `content`, `documentPath` のいずれかを含む
  - `provider` (`local|openai|bedrock`, 任意)
  - `reviewMode` (`fast|standard|deep`, 任意)
  - `goal` (string, 任意): レビューの目的

### `doctor`
- **用途**: MCP サーバーのランタイム状態、DB 接続、知識インデックスの鮮度、メタデータの整合性を診断します。
- **入力**:
  - `clientSnapshot` (任意): クライアント側で保持しているツール情報のスナップショット

---

## 内部・非推奨ツールについて

以下のカテゴリに含まれるツールは、現在 `search_knowledge` や `review_task` 等の主要ツールに統合されているか、内部的な処理で使用されています。Agent が直接呼び出すことは推奨されず、現在の MCP 公開面には含まれていません。

- **Memory**: `store_memory`, `search_memory`, `delete_memory`
- **Graph**: `query_graph`, `digest_text`, `update_graph`, `find_path`, `build_communities`
- **Knowledge (Legacy)**: `get_knowledge`, `search_unified`
- **KnowFlow**: `enqueue_knowledge_task`, `run_knowledge_worker`
- **Experience (Legacy)**: 旧 `record_experience` / `recall_lessons` 系の用途は `record_task_note`、`finish_task`、`search_knowledge` に統合済み
- **Guidance**: `register_guidance`
- **Hook (Legacy)**: 旧 `task_checkpoint` 系の用途は `start_task`、`finish_task`、`review_task` から発火する Hook イベントに統合済み
- **Review (Legacy)**: `review`, `review_document`, `review_implementation_plan`, `review_spec_document` 等

これらの機能の多くは、主要ツールのバックグラウンド処理や、より高レベルな抽象化（Agent-First）を通じて利用可能です。
