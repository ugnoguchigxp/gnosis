# Gnosis: 技術実装の教訓 30 選 (30 Technical Lessons Learned)

本ドキュメントは、Gnosis プロジェクトのコードベースから抽出した、具体的かつ実践的な 30 の実装テクニックを纏めたものです。

---

## 1. 外部プロセス・CLI 連携の堅牢化 (Process)

### 01. Positional Argument の保護 (`--`)
入力テキストが `-` や `---` で始まる場合、CLI がオプションと誤認する。`spawn(cmd, ['--', text])` のように `--` を挟むことで、以降を確実に位置引数として扱わせる。
- [src/services/memory.ts#L20](file:///Users/y.noguchi/Code/gnosis/src/services/memory.ts#L20)

### 02. 標準出力 (stdout) の防衛
MCP サーバーは stdout を通信路とするため、`console.log` は厳禁。すべてのログ（デバッグ含む）は `console.error` (stderr) に徹底リダイレクトする。
- [src/services/llm.ts#L83](file:///Users/y.noguchi/Code/gnosis/src/services/llm.ts#L83)

### 03. `SIGTERM` によるゾンビプロセス防止
重い LLM 処理等がハングした際、`setTimeout` 後に `child.kill('SIGTERM')` を発行し、OS リソースを確実に解放する Promise ラッパーを実装する。
- [src/services/memory.ts#L43-L46](file:///Users/y.noguchi/Code/gnosis/src/services/memory.ts#L43-L46)

### 04. `stdio` の適切な指定
不要な出力を捨て、必要なエラーのみを拾うため、`stdio: ['ignore', 'pipe', 'pipe']` を指定し、入力(stdin)を明示的に無視する（シェルインジェクション対策の副次効果）。
- [src/services/memory.ts#L21](file:///Users/y.noguchi/Code/gnosis/src/services/memory.ts#L21)

---

## 2. データベースと永続化の工夫 (Database)

### 05. SQLite WAL モードの有効化
`PRAGMA journal_mode = WAL` を指定。これにより、バックグラウンドワーカーの書き込み中でも、MCP サーバーがブロックされずに読み取りを継続できる。
- [src/services/background/scheduler.ts#L65](file:///Users/y.noguchi/Code/gnosis/src/services/background/scheduler.ts#L65)

### 06. トランザクションによるアトミックな Queue 抽出
`SELECT` と `UPDATE status='running'` を一つの `db.transaction` で囲む。複数のワーカープロセスが同一トピックを二重に処理することを防ぐ。
- [src/services/background/scheduler.ts#L111-L130](file:///Users/y.noguchi/Code/gnosis/src/services/background/scheduler.ts#L111-L130)

### 07. Drizzle での pgvector インデックス定義
`vector` カラムに対し `using('hnsw', table.embedding.op('vector_cosine_ops'))` を指定。大規模データのミリ秒単位での検索を実現する。
- [src/db/schema.ts#L56-L59](file:///Users/y.noguchi/Code/gnosis/src/db/schema.ts#L56-L59)

### 08. JSONB の高速包含検索 (`@>`)
メタデータの一部でフィルタリングする際、`sql`${table.metadata} @> ${JSON.stringify(filter)}::jsonb`` を使用する。GIN インデックスと組み合わせて高速化。
- [src/services/memory.ts#L230](file:///Users/y.noguchi/Code/gnosis/src/services/memory.ts#L230)

### 09. 部分インデックス (Partial Index) による効率化
`index().where(sql`${table.status} = 'pending'`)` のように、頻繁に参照される特定の状態の行のみをインデックス化し、ストレージ容量を節約しつつ高速化。
- [src/db/schema.ts#L204](file:///Users/y.noguchi/Code/gnosis/src/db/schema.ts#L204)

### 10. JSONB 内部プロパティの抽出とインデックス
`index().on(sql`(${table.metadata}->>'kind')`)` のように、JSON 内部の特定のキーを B-tree インデックス化することで、メタデータベースの検索を高速化。
- [src/db/schema.ts#L52](file:///Users/y.noguchi/Code/gnosis/src/db/schema.ts#L52)

### 11. グラフ構造の整合性保持 (`ON DELETE CASCADE`)
`relations` テーブルの `sourceId` 等に対し `onDelete: 'cascade'` を設定。中心的な `entities` が削除された際の「浮いたエッジ」の発生を自動で防ぐ。
- [src/db/schema.ts#L125](file:///Users/y.noguchi/Code/gnosis/src/db/schema.ts#L125)

### 12. 全文検索 (FTS) とのハイブリッド
ベクトル検索だけでなく `to_tsvector('simple', ${table.text})` を GIN インデックス化し、キーワード検索も併用できるようにする。
- [src/db/schema.ts#L330-L333](file:///Users/y.noguchi/Code/gnosis/src/db/schema.ts#L330-L333)

---

## 3. AI / LLM 実装の堅牢化 (AI Integration)

### 13. 正規表現による JSON ブロックの確実な切り出し
LLM の回答に会話文が混じっても、`output.match(/\{[\s\S]*\}/)` や配列用の `/\[\s*\{[\s\S]*\}\s*\]/` で、パース可能な最初の JSON 部分だけを確実に抽出する。
- [src/services/llm.ts#L99](file:///Users/y.noguchi/Code/gnosis/src/services/llm.ts#L99)

### 14. 決定論的 ID 生成 (Slug-based Hash)
ID をランダムな UUID にせず、`type + normalized-name` から生成する。これにより、別セッションや別エージェントが同じ概念に言及した際に ID が一致し、重複を自動回避できる。
- [src/utils/entityId.ts](file:///Users/y.noguchi/Code/gnosis/src/utils/entityId.ts)

### 15. スコア不足時の `ILIKE` フォールバック
ベクトル検索の類似度スコアが閾値（例: 0.8）を下回った場合、`sql`${entities.name} ILIKE ${`%${query}%`}` で名前の曖昧一致検索に切り替える。
- [src/services/procedure.ts#L241-L254](file:///Users/y.noguchi/Code/gnosis/src/services/procedure.ts#L241-L254)

### 16. Skip if Busy (短時間セマフォ)
バックグラウンドタスク等で、セマフォ取得のタイムアウトを極短（例: 1000ms）に設定。リソースが枯渇している場合に「待つ」のではなく「即座にスキップし、次のイテレーションに任せる」ことで、メインスレッドの詰まりを防ぐ。
- [src/services/background/runner.ts#L150](file:///Users/y.noguchi/Code/gnosis/src/services/background/runner.ts#L150)

### 17. MemoryLoop (LLM 抽象化レイヤー)
モデル（Local / OpenAI / Bedrock）の実装を `runPromptWithMemoryLoopRouter` でラップ。呼び出し側はモデルの種類を意識せず、タスクの性質と複雑度のみを指定する。
- [src/services/memoryLoopLlmRouter.ts](file:///Users/y.noguchi/Code/gnosis/src/services/memoryLoopLlmRouter.ts)

### 18. 再試行時の指数バックオフとジッター
LLM 呼び出しがレート制限等で失敗した場合、`sleep(waitMultiplier * (i + 1))` のように徐々に待機時間を延ばし、リソース集中を分散させる。
- [src/services/memory.ts#L139](file:///Users/y.noguchi/Code/gnosis/src/services/memory.ts#L139)

---

## 4. コード設計と TypeScript の妙技 (Design)

### 19. 軽量 DI パターン (Service `deps`)
関数の引数に `deps: { db?: ...; embed?: ... } = {}` を置く。デフォルト値を本番実装にすることで、DI コンテナなしでユニットテスト時のモック差し替えを実現する。
- [src/services/procedure.ts#L210-L213](file:///Users/y.noguchi/Code/gnosis/src/services/procedure.ts#L210-L213)

### 20. Zod による境界定義の `strict` / `passthrough`
内部の設定定数には `.strict()` を用いて未知のプロパティを弾き、逆に外部サービスからのメタデータ受信には `.passthrough()` を用いて、仕様変更に対する堅牢性を保つ。
- [src/domain/schemas.ts#L100`, `114](file:///Users/y.noguchi/Code/gnosis/src/domain/schemas.ts#L100)

### 21. カスタムエラークラス `GnosisError`
単なる `Error` ではなく `statusHint` (validation/timeout/internal) を持つクラスを定義。上位層（MCP レイヤー）でユーザーへのメッセージを適切に切り替える。
- [src/domain/errors.ts](file:///Users/y.noguchi/Code/gnosis/src/domain/errors.ts)

### 22. 型安全な ID 解決関数の分離
`generateEntityId` のような ID 生成ロジックをサービスから分離し、`EntityType` の `z.enum` と組み合わせることで、ドメイン全体で ID の一貫性を保証する。
- [src/utils/entityId.ts](file:///Users/y.noguchi/Code/gnosis/src/utils/entityId.ts)

### 23. DB エンティティからドメインオブジェクトへの明示的写像
Drizzle の結果をそのまま使わず `mapRowToTask` のような写像関数を通す。DB の命名規則（スネークケース）とロジックの命名基準（キャメルケース）を分離し、責務を分ける。
- [src/services/background/scheduler.ts#L135-L147](file:///Users/y.noguchi/Code/gnosis/src/services/background/scheduler.ts#L135-L147)

### 24. Zod と TypeScript 型推論のシンクロ
`z.infer<typeof Schema>` を多用し、スキーマ定義を単一の真実とすることで、定義の二重管理を排除し、型定義を常に最新に保つ。
- [src/domain/schemas.ts#L23](file:///Users/y.noguchi/Code/gnosis/src/domain/schemas.ts#L23)

---

## 5. 運用とモニタリングの戦術 (Operations)

### 25. ログへの有用なコンテキスト注入 (`process.pid`)
マルチプロセス環境でのログ解析を容易にするため、バックグラウンドワーカーのログに `process.pid` を含め、どのインスタンスの出力かを明確にする。
- [src/services/background/runner.ts#L90](file:///Users/y.noguchi/Code/gnosis/src/services/background/runner.ts#L90)

### 26. 停滞タスクの自動クリーンアップ (`cleanupStaleTasks`)
ステータスが `running` のまま長時間経過したタスクを定期的に `pending` にリセットする。プロセスクラッシュ後のリカバリを自動化する。
- [src/services/background/scheduler.ts#L176-L182](file:///Users/y.noguchi/Code/gnosis/src/services/background/scheduler.ts#L176-L182)

### 27. Dedupe Key による Queue の爆発防止
キューテーブルに `dedupe_key` カラムと `status IN ('pending', 'running')` の部分ユニークインデックスを構築。同一トピックに対する複数の重複タスク投入を DB レベルで遮断する。
- [src/db/schema.ts#L193-L195](file:///Users/y.noguchi/Code/gnosis/src/db/schema.ts#L193-L195)

### 28. `verify:fast` スクリプトによる開発リズムの維持
型チェック、Lint、特定の「失敗パス」テストのみを爆速で実行するスクリプト。コミット頻度を高めつつ、最低限の品質を担保するための必須ツール。
- [package.json#L41](file:///Users/y.noguchi/Code/gnosis/package.json#L41)

### 29. 完了タスクの即時削除による Vacuum 防止
完了したタスク履歴を肥大化させず、`deleteTask` で即座に物理削除する。SQLite のパフォーマンス低下とディスク使用量の増大を防ぐ。
- [src/services/background/runner.ts#L138](file:///Users/y.noguchi/Code/gnosis/src/services/background/runner.ts#L138)

### 30. `config.ts` での環境変数とデフォルト値の一元マッピング
すべての設定値を `config.ts` で `process.env` から型安全に読み取り、デフォルト値を与える。コードベース各所に `process.env` が散らばるのを防ぐ。
- [src/config.ts](file:///Users/y.noguchi/Code/gnosis/src/config.ts)
