# Gnosis 記憶リファクタリング設計書

> **ステータス**: 承認済み (Approved)  
> **作成日**: 2026-04-15  
> **承認日**: 2026-04-16  
> **対象ブランチ**: `main`

---

## 目次

1. [問題提起と動機](#1-問題提起と動機)
2. [目標とする記憶モデル](#2-目標とする記憶モデル)
3. [設計原則](#3-設計原則)
4. [エピソード記憶: ストーリー化](#4-エピソード記憶-ストーリー化)
5. [手続き記憶: 小タスク × Graph](#5-手続き記憶-小タスク--graph)
6. [フィードバックループ: confidence スコアリング](#6-フィードバックループ-confidence-スコアリング)
7. [マイグレーション判定](#7-マイグレーション判定)
8. [現在のリポジトリ概念との対応](#8-現在のリポジトリ概念との対応)
9. [実装フェーズ計画](#9-実装フェーズ計画)
10. [リスク・トレードオフ・非ゴール](#10-リスクトレードオフ非ゴール)
11. [将来の拡張について](#11-将来の拡張について)

---

## 1. 問題提起と動機

### 現状の課題

| 課題 | 影響箇所 | 具体例 |
|------|---------|--------|
| `vibe_memories` に何でも保存される | `src/services/guidance/register.ts` | Guidance Registry が `metadata.kind: 'guidance'` で vibe_memories に同居 |
| `type` / `relationType` が自由記述 | `src/services/llm.ts` L176 | LLM が `"Tool"` / `"tool"` / `"Library"` をバラバラに生成 |
| `description` がスカスカ | `src/services/graph.ts` | 2語程度の description ではベクトル検索の精度が出ない |
| エンティティ ID を LLM が生成 | `src/services/llm.ts` | 同じ概念が `"bun"` / `"bun-runtime"` で重複 |
| 忘却・圧縮の仕組みがない | — | 長期運用でデータが肥大化 |

### LLM にとって本当に必要な記憶

| LLM の弱点 | 必要な記憶 | Gnosis での対応 |
|---|---|---|
| **忘れる**（前のセッションを知らない） | 過去の体験の想起 | エピソード記憶 |
| **学ばない**（同じ失敗を繰り返す） | 教訓の蓄積と参照 | エピソード記憶 |
| **知らない**（プロジェクト固有の事情） | ルール・方針の注入 | 手続き記憶（`scope: 'always'`） |
| **一貫しない**（判断基準がブレる） | ベストプラクティス参照 | 手続き記憶（task + confidence） |

普遍的事実は LLM の事前学習や Web 検索 MCP で十分なため、Gnosis は保持しない。

---

## 2. 目標とする記憶モデル

```text
┌────────────────────────────────────────────────┐
│              LLM (Context Window)              │
│  短期記憶 / ワーキングメモリ（Gnosis管轄外）     │
└────────────────────────────────────────────────┘
                        │
┌────────────────────────────────────────────────┐
│                  Gnosis                        │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │  エピソード記憶 (vibe_memories)           │  │
│  │  ストーリー化された体験・教訓             │  │
│  │  → LLM が search_memory で能動的に検索   │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │  手続き記憶 (entities + relations)        │  │
│  │  小タスク × Graph + フィードバックループ  │  │
│  │  → query_procedure で目標達成時に取得    │  │
│  │  → scope:'always' は自動注入（暗黙知）    │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  ※ 普遍的事実は Web 検索 MCP に委譲           │
│  ※ entities/relations は手続き記憶の Graph    │
│    インフラ。「意味記憶」として独立させない     │
└────────────────────────────────────────────────┘
```

### 意味記憶を独立層にしない理由

- プロジェクト固有の事実は手続き記憶の `constraint` / `context` で表現できる
- 普遍的事実は LLM / Web 検索 MCP で十分
- 独立層にしてもフィードバックループに参加できず、出力のない消費専用データになる

---

## 3. 設計原則

| 原則 | 内容 |
|------|------|
| **2層構造** | エピソード記憶（vibe_memories）と手続き記憶（entities + relations）の2層 |
| **新テーブル不要** | 既存テーブルへの `ALTER TABLE ADD COLUMN` のみ |
| **プロンプト改善優先** | スキーマ変更より先にプロンプトの制御語彙導入で品質を上げる |
| **Graph がスキルになる** | 固定 SKILL テーブルは作らない。`query_procedure` で部分グラフ取得 = 動的スキル |
| **フィードバック駆動** | 実行結果 → confidence 更新 → Graph 自律進化 |
| **暗黙知は配信モード** | `scope: 'always'` の constraint は独立層ではなく手続き記憶の自動注入バリアント |

### 実装開始前に確定すること

計画をそのままコード化すると契約不一致が起きやすいため、着手前に以下を固定する。

1. **LLM 出力と永続化入力を分離する**
  - LLM は `id` を出さない
  - 保存層で `generateEntityId(type, name)` を使って ID を解決する
  - 既存の `EntityInputSchema` / `RelationInputSchema` は当面の互換性のため残す

2. **MCP の注入場所を現行構成に合わせる**
  - 現行の入口は `src/mcp/server.ts`
  - `src/mcp/handlers.ts` は存在しないため、注入ロジックは server 側の共通ラッパーまたは各 tool handler の前処理として実装する

3. **Guidance は移行期間を設ける**
  - 新しい Graph 保存を追加しても、既存の `vibe_memories` 参照は即時に壊さない
  - まずは dual-write / read compatibility を維持し、その後に読み取り元を切り替える

---

## 4. エピソード記憶: ストーリー化

### 現状の問題

`vibe_memories` は断片的なメモの寄せ集め。`reflect_on_memories`（`src/services/synthesis.ts`）で entities/relations に昇格後、元のメモは `is_synthesized: true` になるだけでエピソードとしての価値が活かされない。

### 設計: 2段階パイプライン

```text
Phase A: 蓄積（現行通り）
  store_memory → vibe_memories（memory_type: 'raw'）

Phase B: ストーリー化（新設: consolidate_episodes）
  入力: vibe_memories WHERE memory_type = 'raw' AND is_synthesized = false
       + experience_logs WHERE session_id = 対象セッション
  処理: LLM でナラティブ統合
  出力: vibe_memories INSERT（memory_type: 'episode', compressed: true）
  後処理: 元の raw メモの is_synthesized を true に更新

Phase C: 構造化抽出（既存 reflect の拡張）
  入力: vibe_memories WHERE memory_type = 'episode' AND is_synthesized = false
  処理: entities / relations 抽出（task / goal / constraint 含む）
  後処理: 元の episode の is_synthesized を true に更新
```

### ストーリー化の利点

| 利点 | 効果 |
|------|------|
| 検索精度向上 | 断片5件をベクトル検索するよりストーリー1件の方がヒット率が高い |
| トークン効率 | 断片10件（2000トークン）→ ストーリー1件（500トークン） |
| 因果関係の保存 | 「何が起きた→なぜ→結果どうなった」が1レコードにまとまる |

### `experience_logs` との関係

テーブル統合はしない（`scenarioId` / `attempt` / `failureType` のハーネス密結合フィールドがあるため）。ストーリー化の**入力として参照**するのみ。

### スキーマ拡張

**対象ファイル**: `src/db/schema.ts` の `vibeMemories` テーブル定義

```typescript
// 既存フィールドの後に追加
memoryType: text('memory_type').default('raw'),
  // 'raw' = 生メモ（従来の store_memory の出力）
  // 'episode' = ストーリー化済み（consolidate_episodes の出力）
episodeAt: timestamp('episode_at'),
  // 出来事が起きた時刻。createdAt（保存時刻）と区別する
sourceTask: text('source_task'),
  // 由来タスク ID（例: KnowFlow の topic_tasks.id）
importance: real('importance').default(0.5),
  // 重要度 0.0-1.0。consolidate_episodes 時に LLM が判定
compressed: boolean('compressed').default(false),
  // true = LLM による要約版。元の raw メモは別途保持
```

### consolidate_episodes の実装仕様

**新設ファイル**: `src/services/consolidation.ts`

```typescript
/**
 * 同一セッションの raw メモ + experience_logs をストーリー化する。
 *
 * @param sessionId - 対象セッション ID
 * @param deps.db - Drizzle DB インスタンス
 * @param deps.llm - LLM 呼び出し関数
 * @param deps.embedText - 埋め込みベクトル生成関数
 * @returns 生成された episode の vibe_memories.id
 *
 * トリガー条件（呼び出し元が判断）:
 *   - 同一セッションの raw メモが 5件以上蓄積
 *   - または明示的な MCP ツール呼び出し
 *
 * 処理:
 *   1. vibe_memories WHERE session_id = ? AND memory_type = 'raw'
 *      AND is_synthesized = false を取得（created_at ASC）
 *   2. experience_logs WHERE session_id = ? を取得
 *   3. 下記プロンプトで LLM を呼び出し
 *   4. 結果を vibe_memories に INSERT（memory_type: 'episode'）
 *   4a. entities にも episode プロキシを INSERT（type: 'episode', metadata.memoryId）
 *       → Phase C で learned_from 関係のターゲットとして使用
 *   5. 元の raw メモの is_synthesized を true に UPDATE
 */
```

**LLM プロンプト**:

```text
以下のメモと体験記録を1つのストーリーに統合してください。

【厳守事項】
1. 入力にない情報を絶対に追加しないでください
2. 以下の3要素を含む因果関係のあるナラティブにしてください:
   - 何が起きたか（状況・行動）
   - なぜそうなったか（原因・判断理由）
   - 結果どうなったか（成功/失敗・教訓）
3. パスワード、APIキー、認証トークン、個人情報は除外してください
4. 出力は以下のJSON形式のみ:

{
  "story": "ストーリー本文（200-500文字）",
  "importance": 0.0-1.0の数値,
  "episodeAt": "出来事の中心的な時刻（ISO 8601）"
}

--- メモ一覧 ---
{memories}

--- 体験記録（あれば） ---
{experiences}
```

### 注意事項

| 懸念 | 対策 |
|------|------|
| ストーリー化で情報が欠落 | 元の raw メモは即時削除せず `is_synthesized: true` で保持。将来の忘却バッチでパージ |
| LLM の幻覚混入 | プロンプトで「入力にない情報を追加するな」を厳格指示。元メモ ID を metadata.sourceIds に保持 |
| いつストーリー化するか | 同一セッションの raw メモが5件以上蓄積時、または明示的呼び出し |

---

## 5. 手続き記憶: 小タスク × Graph

### 設計思想

**「スキル」というオブジェクトは存在しない。Graph の部分グラフ取得が動的にスキルになる。**

```text
query_procedure("PRレビューしたい")
  → Graph 探索で関連 task ノードを収集
  → confidence でランキング + context でフィルタ
  → トポロジカルソートで順序付け
  → LLM がその場で判断に使う = スキル的挙動
```

### エンティティ type の制御語彙（完全一覧）

**適用場所**: `src/services/llm.ts` の `distillKnowledgeFromTranscript` プロンプト（L176付近）および `extractEntitiesFromText` プロンプト（L42付近）

| type | 用途 | 粒度の目安 | 例 |
|------|------|-----------|-----|
| `task` | 単一の行動単位 | 1判断・1アクション | 「差分の安全性を確認する」 |
| `goal` | 達成したい状態 | 複数 task の親 | 「PRが安全にマージ可能」 |
| `constraint` | 禁止事項・守るべきルール | 1ルール | 「秘密情報をログに出さない」 |
| `context` | task/goal の適用条件 | 1条件 | 「緊急対応時」「DB関連の変更」 |
| `project` | プロジェクト | — | 「gnosis」 |
| `library` | ライブラリ・フレームワーク | — | 「drizzle-orm」 |
| `service` | サービス・API | — | 「postgresql」 |
| `tool` | ツール・CLI | — | 「biome」 |
| `concept` | 技術概念・アルゴリズム | — | 「HNSW インデックス」「コサイン類似度」 |
| `person` | 人物 | — | — |
| `pattern` | 再利用可能な設計・アーキテクチャパターン | — | 「Repository パターン」「CQRS」 |
| `config` | 設定・環境変数 | — | 「DATABASE_URL」 |
| `episode` | エピソードのプロキシ | — | `learned_from` 関係のターゲット用。対応する `vibe_memories.id` を `metadata.memoryId` に保持 |

### リレーション relationType の制御語彙（完全一覧）

**適用場所**: 同上

| relationType | 方向 | 意味 | 例 |
|---|---|---|---|
| `has_step` | goal → task | goal を達成するためのステップ | PRレビュー → 差分確認 |
| `precondition` | task → task | 先に完了が必要 | テスト実行 → CI通過確認 |
| `follows` | task → task | 推奨実行順序 | 影響範囲確認 → 修正方針決定 |
| `when` | context → goal/task | この条件のとき適用 | 緊急対応時 → 影響範囲優先 |
| `prohibits` | constraint → task | この行為を禁止 | 秘密情報保護 → ログ出力 |
| `learned_from` | task/constraint → episode（※） | この体験が根拠 | 再現確認 → incident記録 |

> **※ `learned_from` の実装上の注意**: episode は `vibe_memories` に格納されるため `entities.id` を FK とする `relations` テーブルでは直接リンクできない。対処方針として、(a) task の `metadata.episodeIds` に vibe_memories.id の配列を保持する、または (b) episode を entities にも薄いプロキシとして INSERT（`type: 'episode'`, description にストーリー本文）する。本設計では **(b)** を採用し、`query_procedure` の episode 収集時に entities 経由で vibe_memories を JOIN する。
| `alternative_to` | task ↔ task | 代替手段（双方向） | 全件テスト ↔ 影響範囲テスト |
| `depends_on` | any → any | 依存関係 | サービスA → ライブラリB |
| `uses` | any → any | 使用関係 | プロジェクト → ツール |
| `implements` | any → any | 実装関係 | — |
| `extends` | any → any | 拡張関係 | — |
| `part_of` | any → any | 部分関係 | — |
| `caused_by` | any → any | 原因 | — |
| `resolved_by` | any → any | 解決手段 | — |

### エンティティ ID の生成規則

**適用場所**: `src/services/graph.ts` の `saveEntities` 関数

**現状**: LLM が `id` を自由に生成 → 同じ概念が `"bun"` / `"bun-runtime"` で重複。

**変更後**: LLM は `id` を生成しない。`name` と `type` から決定的に生成する。保存層は LLM 由来入力を正規化して ID を補完する。

```typescript
// src/utils/entityId.ts（新設）
export function generateEntityId(type: string, name: string): string {
  // 1. name を正規化: 小文字化、連続スペースを単一ハイフンに、先頭末尾トリム
  const normalized = name.trim().toLowerCase().replace(/\s+/g, '-');
  // 2. type + "/" + normalized でスラッグ化
  return `${type}/${normalized}`;
  // 例: "library/drizzle-orm", "task/差分の安全性を確認する"
}
```

**衝突時**: 既存の `saveEntities` の embedding 類似度 + LLM マージ判定ロジックはそのまま維持。ID が同一なら ON CONFLICT DO UPDATE で上書きされる（既存動作と同じ）。

**互換性メモ**:

- `src/domain/schemas.ts` の既存スキーマは Phase 1 中は壊さない
- LLM から返る「ドラフト」は `type + name` ベースで正規化し、保存時に `id` を付与する
- 既存の手書き入力やテストは、必要なら明示的な `id` を引き続き渡してよい

### 抽出プロンプトの改善

**対象ファイル**: `src/services/llm.ts` の `distillKnowledgeFromTranscript` 関数内プロンプト（L176付近）

**現行プロンプト**（`src/services/llm.ts` L191付近、問題箇所のみ）:

```text
"entities": [{ "id": "唯一のID", "type": "種別", "name": "名前", "description": "説明" }],
"relations": [{ "sourceId": "ID1", "targetId": "ID2", "relationType": "関係名", "weight": 1.0 }]
```

**変更後**:

```text
"entities": [
  {
    "type": "以下から1つ選択: task|goal|constraint|context|project|library|service|tool|concept|person|pattern|config|episode",
    "name": "正規化された名前（公式名称、日本語可）",
    "description": "50文字以上の説明。何であるか、なぜ重要かを含む。短すぎる説明は不可"
  }
],
"relations": [
  {
    "sourceType": "source の type",
    "sourceName": "source の name",
    "targetType": "target の type",
    "targetName": "target の name",
    "relationType": "以下から1つ選択: has_step|precondition|follows|when|prohibits|learned_from|alternative_to|depends_on|uses|implements|extends|part_of|caused_by|resolved_by",
    "weight": 0.0-1.0
  }
]
```

> **注意**: relations の LLM 出力は `sourceType/sourceName` / `targetType/targetName` のドラフトに変更する。受信側で `generateEntityId(sourceType, sourceName)` / `generateEntityId(targetType, targetName)` を呼んで ID を解決する。既存 API 互換のため、永続化層の `sourceId` / `targetId` は残す。

**同様に `src/services/llm.ts` の `extractEntitiesFromText` プロンプト（L53付近）も変更する。**

### コミュニティ要約の改善

**対象ファイル**: `src/services/community.ts` の `buildCommunities` 関数

**現状の問題**: relations のコンテキストが entity ID で表示される（`"abc123 → def456"`）ため LLM が要約しにくい。

**変更**: relations を LLM に渡す際に `entity.name` に解決してから渡す。

```diff
- `${r.sourceId} --[${r.relationType}]--> ${r.targetId}`
+ `${sourceName} --[${r.relationType}]--> ${targetName}`
```

`sourceName` / `targetName` は `groupEntities` から `r.sourceId` / `r.targetId` を key にして解決する。

### Graph 構造例

```text
[goal: PRレビュー完了]
  ├─ has_step → [task: 差分の安全性確認]
  │               ├─ learned_from → [episode: SQL injection見逃し事件]
  │               └─ precondition → [task: CI通過確認]
  ├─ has_step → [task: テストカバレッジ検証]
  │               └─ alternative_to → [task: 手動テスト確認]
  ├─ has_step → [task: パフォーマンス影響評価]
  │               └─ when ← [context: パフォーマンスクリティカル]
  └─ has_step → [task: 破壊的変更チェック]
                    └─ prohibits ← [constraint: 段階リリース必須]
```

同じ `task` が複数の `goal` から参照される — これが Graph の強み。

### 暗黙知（scope: 'always'）

entities に `scope` フィールドを追加。`scope: 'always'` のエンティティは MCP ツール呼び出し時に自動で system prompt に注入する。

**注入の実装場所**: `src/mcp/server.ts` のツールハンドラ共通前処理、または各 tool handler の冒頭

```typescript
// 各 MCP ツール呼び出しの冒頭で:
// 1. entities WHERE scope = 'always' を取得（キャッシュ可、TTL: 5分）
// 2. 取得した constraint / context を system prompt のプレフィックスとして注入
// 3. project フィルタ: when 関係で context に紐づくものは、現在の context に合致する場合のみ注入
```

### 新 MCP ツール: `query_procedure`

**新設ファイル**: `src/mcp/tools/queryProcedure.ts`

```typescript
// Zod 入力スキーマ
const QueryProcedureInput = z.object({
  goal: z.string().describe('達成したい目標（テキスト）'),
  context: z.string().optional().describe('現在の状況・条件（テキスト、任意）'),
});

// Zod 出力スキーマ
const QueryProcedureOutput = z.object({
  goal: z.object({ id: z.string(), name: z.string(), description: z.string() }),
  tasks: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    confidence: z.number(),
    order: z.number(),          // トポロジカルソート順
    episodes: z.array(z.object({  // learned_from で紐づくエピソード
      id: z.string(),
      story: z.string(),
    })),
  })),
  constraints: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
  })),
});
```

**処理フロー**（`src/services/procedure.ts` 新設）:

```typescript
/**
 * 1. goal 検索: goal テキストの embedding を生成し、
 *    entities WHERE type = 'goal' からコサイン類似度 TOP 1 を取得。
 *    類似度が 0.8 未満なら name 部分一致でフォールバック。
 *
 * 2. task 収集: goal から has_step 関係を辿り task を収集。
 *    各 task から follows / precondition を再帰的に辿る（最大3ホップ）。
 *
 * 3. context フィルタ: context が指定されていれば、
 *    when 関係で紐づく context エンティティと入力 context の
 *    embedding 類似度を計算し、閾値 0.7 以上の task のみ残す。
 *    context が未指定なら全 task を返す（when 付き task も含む）。
 *
 * 4. constraint 収集: 収集した task に prohibits 関係で紐づく
 *    constraint を収集。
 *
 * 5. episode 収集: 各 task の learned_from 関係で紐づく
 *    entities (type = 'episode') を取得し、その metadata.memoryId で
 *    vibe_memories のストーリー本文を取得。
 *
 * 6. トポロジカルソート: precondition / follows 関係から DAG を構築し
 *    トポロジカルソート。循環がある場合は confidence 降順でフォールバック。
 *
 * 7. confidence フィルタ: confidence < 0.3 の task は末尾に
 *    「参考（低信頼度）」として分離。
 */
```

### `register_guidance` の保存先変更

**対象ファイル**: `src/services/guidance/register.ts` の `saveGuidance` 関数

**現行動作**: `vibe_memories` に `metadata.kind: 'guidance'` で INSERT。

**変更後の動作**:

```text
1. 入力の guidanceType に応じて type を決定:
   - guidanceType: 'rule' → type: 'constraint'
   - guidanceType: 'skill' → type: 'task'
   （新規追加: guidanceType: 'goal' → type: 'goal'）

2. entities に INSERT（generateEntityId で ID 生成）:
   - type: 上記で決定
   - name: title
   - description: content
   - confidence: 0.5（初期値）
   - scope: 入力の scope（'always' | 'on_demand'）
   - provenance: 'manual'

3. applicability がある場合:
   - 各条件を context エンティティとして INSERT
   - when 関係で紐付け

4. tags がある場合:
   - metadata.tags に保存（entities の既存 metadata フィールド）

5. 既存の vibe_memories (kind:guidance) は読み取りのみ維持（移行期間）
```

**移行方針メモ**:

- Phase 4-3 で Graph への保存を開始しても、旧 guidance メモはすぐに削除しない
- 旧メモの読み取りを止めるのは、Graph 側の登録と検索が安定してからにする
- そのため、移行直後は `vibe_memories` と `entities/relations` の両方が存在してよい

### task の蓄積フロー（まとめ）

| 蓄積方法 | トリガー | 初期 confidence |
|---------|---------|----------------|
| `register_guidance` で手動登録 | ユーザー操作 | 0.5 |
| `reflect_on_memories` で自動抽出 | consolidate_episodes 後のバッチ | 0.3 |
| `record_outcome` の改善提案 | フィードバック時 | 0.3 |
| `buildCommunities` でクラスタから goal 候補発見 | 明示的トリガー | 0.3 |

### スキーマ拡張

**対象ファイル**: `src/db/schema.ts`

#### entities テーブル

```typescript
// 既存フィールドの後に追加
confidence: real('confidence').default(0.5),
  // 確信度 0.0-1.0。record_outcome で更新される
provenance: text('provenance'),
  // 出所。'manual' | 'reflect' | 'knowflow' | 'feedback' | URL
freshness: timestamp('freshness'),
  // 最終検証日時。record_outcome 時に更新
scope: text('scope'),
  // 'always'（自動注入）| 'on_demand'（query_procedure で取得）| null（通常エンティティ）
```

#### relations テーブル

```typescript
// 既存フィールドの後に追加
confidence: real('confidence').default(0.5),
recordedAt: timestamp('recorded_at').defaultNow(),
  // この関係が記録された日時
sourceTask: text('source_task'),
  // 由来タスク ID
provenance: text('provenance'),
  // 出所（entities と同じ形式）
```

---

## 6. フィードバックループ: confidence スコアリング

### 全体フロー

```text
query_procedure(goal) → task リスト取得
         ↓
LLM が task に沿って実行
         ↓
record_outcome → confidence 更新 + エピソード記録 + 改善 task 追加
         ↓
Graph が進化 → 次回の query_procedure はより良い結果を返す
```

### confidence 更新ルール

```typescript
// src/services/procedure.ts 内の updateConfidence 関数

function updateConfidence(current: number, event: ConfidenceEvent): number {
  let delta: number;
  switch (event) {
    case 'followed_success':
      // task に従って成功 → 上昇（上限に近づくほど上がりにくい）
      delta = 0.1 * (1 - current);
      break;
    case 'followed_failure':
      // task に従って失敗 → 下降（下限に近づくほど下がりにくい）
      delta = -0.15 * current;
      break;
    case 'ignored_success':
      // task を無視して成功 → 微下降（不要だった可能性）
      delta = -0.05;
      break;
    case 'ignored_failure':
      // task を無視して失敗 → 上昇（やはり必要だった）
      delta = 0.05;
      break;
  }
  // クランプ: 0.0 - 1.0
  return Math.max(0.0, Math.min(1.0, current + delta));
}
```

### confidence によるフィルタリング

| 範囲 | query_procedure での扱い |
|------|------------------------|
| `≥ 0.7` | 信頼できる task。上位に表示 |
| `0.3 - 0.7` | 未検証 or 普通。表示するが `⚠️` 注釈付き |
| `< 0.3` | 信頼性が低い。末尾に「参考（低信頼度）」として分離 |
| `< 0.1` | 自動 deprecate 候補。`buildCommunities` 実行時に `metadata.deprecated: true` をセット |

### 新 MCP ツール: `record_outcome`

**新設ファイル**: `src/mcp/tools/recordOutcome.ts`

```typescript
// Zod 入力スキーマ
const RecordOutcomeInput = z.object({
  goalId: z.string().describe('実行した goal の entity ID'),
  taskResults: z.array(z.object({
    taskId: z.string().describe('task の entity ID'),
    followed: z.boolean().describe('この task に従ったか'),
    succeeded: z.boolean().describe('結果は成功か'),
    note: z.string().optional().describe('何が起きたか（自由記述）'),
  })),
  improvements: z.array(z.object({
    type: z.enum(['modify_task', 'add_task', 'add_precondition', 'add_constraint']),
    targetTaskId: z.string().optional().describe('modify_task / add_precondition の対象'),
    suggestion: z.string().describe('改善内容'),
  })).optional(),
});
```

**処理フロー**（`src/services/procedure.ts` に追加）:

```text
record_outcome 受信:

① confidence 更新
   各 taskResult に対して:
   - event = followed × succeeded の組み合わせで決定
   - entities.confidence を updateConfidence で更新
   - entities.freshness を現在時刻に更新
   - entities.lastReferencedAt を現在時刻に更新

② エピソード記録
   taskResults + goal 情報を元にストーリーを生成:
   - LLM プロンプト: 「以下のタスク実行結果を1つのエピソードとして要約せよ」
   - vibe_memories に INSERT（memory_type: 'episode'）
   - entities にも episode プロキシを INSERT（type: 'episode', metadata.memoryId に vibe_memories.id）
   - 各 task に learned_from 関係を追加（source: task, target: episode プロキシ）

③ 改善提案の適用（improvements がある場合）
   - modify_task: 対象 entity の description を更新
   - add_task: 新 entity INSERT（type: 'task', confidence: 0.3）
               + goal → 新task に has_step 関係追加
   - add_precondition: targetTask → 新task に precondition 関係追加
   - add_constraint: 新 entity INSERT（type: 'constraint', confidence: 0.3）
                     + targetTask に prohibits 関係追加
```

---

## 7. マイグレーション判定

### 必要な変更（全て `ALTER TABLE ADD COLUMN`）

| テーブル | 追加カラム | 型 | デフォルト値 | 既存データへの影響 |
|---------|----------|----|-----------|--------------------|
| vibe_memories | memory_type | text | `'raw'` | なし（全行が 'raw' になる = 正しい） |
| vibe_memories | episode_at | timestamp | NULL | なし |
| vibe_memories | source_task | text | NULL | なし |
| vibe_memories | importance | real | `0.5` | なし |
| vibe_memories | compressed | boolean | `false` | なし |
| entities | confidence | real | `0.5` | なし（初期値として妥当） |
| entities | provenance | text | NULL | なし |
| entities | freshness | timestamp | NULL | なし |
| entities | scope | text | NULL | なし（既存は通常エンティティ） |
| relations | confidence | real | `0.5` | なし |
| relations | recorded_at | timestamp | `now()` | なし |
| relations | source_task | text | NULL | なし |
| relations | provenance | text | NULL | なし |

### マイグレーション SQL（0010）

```sql
-- 0010_memory_refactoring.sql
ALTER TABLE vibe_memories
  ADD COLUMN IF NOT EXISTS memory_type text DEFAULT 'raw',
  ADD COLUMN IF NOT EXISTS episode_at timestamp,
  ADD COLUMN IF NOT EXISTS source_task text,
  ADD COLUMN IF NOT EXISTS importance real DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS compressed boolean DEFAULT false;

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS confidence real DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS provenance text,
  ADD COLUMN IF NOT EXISTS freshness timestamp,
  ADD COLUMN IF NOT EXISTS scope text;

ALTER TABLE relations
  ADD COLUMN IF NOT EXISTS confidence real DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS recorded_at timestamp DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source_task text,
  ADD COLUMN IF NOT EXISTS provenance text;

-- クエリで頻用されるカラムにインデックスを追加
CREATE INDEX IF NOT EXISTS vibe_memories_memory_type_idx
  ON vibe_memories (memory_type);
CREATE INDEX IF NOT EXISTS entities_scope_idx
  ON entities (scope) WHERE scope IS NOT NULL;
CREATE INDEX IF NOT EXISTS entities_type_confidence_idx
  ON entities (type, confidence);
```

### 判定結果

| 項目 | 判定 |
|------|------|
| 破壊的変更 | **なし** |
| 新テーブル | **なし** |
| 既存データへの影響 | **なし** |
| 必要なマイグレーション数 | **1本** |
| ダウンタイム | **なし** |
| ロールバック | `ALTER TABLE DROP COLUMN` で即時復旧 |
| **総合判定** | **✅ マイグレーションする価値あり。リスク極低** |

---

## 8. 現在のリポジトリ概念との対応

| 現在の概念 | 新モデルでの位置づけ | 変更するファイル |
|---|---|---|
| `vibe_memories` | エピソード記憶 | `src/db/schema.ts`, `src/mcp/tools/memory.ts` |
| `vibe_memories` (kind:guidance) | 手続き記憶へ移行 | `src/services/guidance/register.ts`, `src/mcp/tools/guidance.ts` |
| `experience_logs` | エピソードの入力源 | 変更なし（参照のみ） |
| `entities` | 手続き記憶の Graph ノード | `src/db/schema.ts`, `src/services/graph.ts` |
| `relations` | 手続き記憶の Graph エッジ | `src/db/schema.ts`, `src/services/graph.ts` |
| `communities` | Graph クラスター | `src/services/community.ts`（要約改善のみ） |
| `knowledge_*` | 変更なし | — |
| `sync` | 変更なし | — |
| `synthesis` (reflect) | 2段階目 + task 抽出追加 | `src/services/synthesis.ts` |

---

## 9. 実装フェーズ計画

### Phase 1: 抽出プロンプトの改善（スキーマ変更なし）

**目標**: Graph の品質をプロンプト改善だけで向上させる。  
**前提条件**: なし  
**成果物**: 変更されたプロンプト、新設の `entityId.ts`

| # | タスク | 対象ファイル | 受け入れ条件 |
|---|-------|-------------|-------------|
| 1-1 | `generateEntityId` ユーティリティ新設 | `src/utils/entityId.ts`（新設） | `generateEntityId('library', 'Drizzle ORM')` → `'library/drizzle-orm'` |
| 1-2 | LLM 出力のドラフト契約を更新 | `src/services/llm.ts`, `src/domain/schemas.ts` | `entities` / `relations` の LLM 出力が name/type ベースに揃う |
| 1-3 | `distillKnowledgeFromTranscript` プロンプト変更 | `src/services/llm.ts` L176付近 | type / relationType が制御語彙のみ。description 50文字以上指示。relations が name ベース |
| 1-4 | `extractEntities` プロンプト変更 | `src/services/llm.ts` L42付近 | 同上 |
| 1-5 | `saveEntities` で ID 生成ロジック変更 | `src/services/graph.ts` | LLM 出力の `name` + `type` から `generateEntityId` で ID 生成 |
| 1-6 | `saveRelations` で ID 解決ロジック変更 | `src/services/graph.ts` | LLM 出力の `sourceType/sourceName` / `targetType/targetName` から ID を解決 |
| 1-7 | 互換性テスト追加 | `test/synthesis.test.ts`, `test/graph.test.ts` | 旧 `id` 付き入力と新ドラフト入力の両方が通る |
| 1-8 | コミュニティ要約で name 表示 | `src/services/community.ts` | relations コンテキストが `name -[type]-> name` 形式 |
| 1-9 | 制御語彙テスト追加 | `test/synthesis.test.ts`, `test/graph.test.ts` | 制御語彙外の type がバリデーションエラーになること |

### Phase 2: スキーマ拡張（マイグレーション 0010）

**目標**: エピソード記憶と手続き記憶に必要なフィールドを追加する。  
**前提条件**: Phase 1 完了  
**成果物**: マイグレーションファイル、更新された Drizzle スキーマ

| # | タスク | 対象ファイル | 受け入れ条件 |
|---|-------|-------------|-------------|
| 2-1 | マイグレーション SQL 作成 | `drizzle/0010_memory_refactoring.sql`（新設） | §7 の SQL が正常に実行できる |
| 2-2 | Drizzle スキーマ更新 | `src/db/schema.ts` | vibeMemories / entities / relations に新カラム定義追加 |
| 2-3 | domain スキーマの整合 | `src/domain/schemas.ts` | 追加カラムに合わせた入力・出力契約が揃う |
| 2-4 | スナップショット更新 | `drizzle/meta/` | `bun run drizzle-kit generate` で生成 |
| 2-5 | 既存テスト通過確認 | 全テスト | `bun test` が全て PASS |

### Phase 3: エピソード記憶のストーリー化

**目標**: 断片メモをストーリー化されたエピソードに統合する。  
**前提条件**: Phase 2 完了  
**成果物**: `consolidation.ts`、更新された `synthesis.ts`

| # | タスク | 対象ファイル | 受け入れ条件 |
|---|-------|-------------|-------------|
| 3-1 | `consolidateEpisodes` 関数実装 | `src/services/consolidation.ts`（新設） | 同一セッションの raw メモ5件 → ストーリー1件が生成される |
| 3-2 | `consolidate_episodes` MCP ツール登録 | `src/mcp/tools/memory.ts`, `src/mcp/tools/index.ts` | MCP 経由で呼び出し可能 |
| 3-3 | `reflect_on_memories` の入力変更 | `src/services/synthesis.ts` | `memory_type = 'episode'` のみを対象にする |
| 3-4 | `store_memory` 入力スキーマ拡張 | `src/mcp/tools/memory.ts` | `memoryType`, `episodeAt`, `importance` が指定可能 |
| 3-5 | テスト追加 | `test/consolidation.test.ts`（新設） | ストーリー化の入出力、experience_logs 参照 |

### Phase 4: 手続き記憶（小タスク × Graph + 暗黙知）

**目標**: スキル的挙動と暗黙知の自動注入を実現する。  
**前提条件**: Phase 2 完了（Phase 3 と並行可能）  
**成果物**: `procedure.ts`、更新された `guidance/register.ts`、`queryProcedure.ts`

| # | タスク | 対象ファイル | 受け入れ条件 |
|---|-------|-------------|-------------|
| 4-1 | `queryProcedure` 関数実装 | `src/services/procedure.ts`（新設） | goal テキスト → 順序付き task リスト + constraints + episodes |
| 4-2 | `query_procedure` MCP ツール登録 | `src/mcp/tools/queryProcedure.ts`（新設）, `src/mcp/tools/index.ts` | MCP 経由で呼び出し可能 |
| 4-3 | `saveGuidance` 保存先変更 | `src/services/guidance/register.ts` | entities/relations に保存。vibe_memories への書き込みを停止 |
| 4-3a | `GuidanceTypeSchema` に `goal` 追加 | `src/domain/schemas.ts`, `src/mcp/tools/guidance.ts` | `guidanceType: 'goal'` が受け付けられること |
| 4-4 | scope:'always' 自動注入 | `src/mcp/server.ts` | entities WHERE scope='always' が各ツール呼び出し時に注入される |
| 4-5 | `reflect_on_memories` で task 抽出 | `src/services/synthesis.ts` | エピソードから type:'task' エンティティ + learned_from 関係が生成される |
| 4-6 | テスト追加 | `test/procedure.test.ts`（新設） | query_procedure / register_guidance 移行のテスト |

### Phase 5: フィードバックループ

**目標**: 実行結果で Graph を自律的に進化させる。  
**前提条件**: Phase 4 完了  
**成果物**: `recordOutcome.ts`、`procedure.ts` への追加

| # | タスク | 対象ファイル | 受け入れ条件 |
|---|-------|-------------|-------------|
| 5-1 | `updateConfidence` 関数実装 | `src/services/procedure.ts` | 4パターンの confidence 計算が正しく動作 |
| 5-2 | `recordOutcome` 関数実装 | `src/services/procedure.ts` | confidence 更新 + エピソード記録 + 改善提案適用 |
| 5-3 | `record_outcome` MCP ツール登録 | `src/mcp/tools/recordOutcome.ts`（新設）, `src/mcp/tools/index.ts` | MCP 経由で呼び出し可能 |
| 5-4 | `queryProcedure` に confidence フィルタ追加 | `src/services/procedure.ts` | `< 0.3` が末尾分離、`< 0.1` が除外 |
| 5-5 | deprecate 候補フラグ | `src/services/community.ts` | `buildCommunities` 時に confidence < 0.1 の entity に `metadata.deprecated: true` |
| 5-6 | テスト追加 | `test/procedure.test.ts` | confidence 更新4パターン + クランプ |

---

## 10. リスク・トレードオフ・非ゴール

### リスク

| リスク | 深刻度 | 対策 |
|--------|--------|------|
| スキーマ変更による移行コスト | 極低 | ADD COLUMN + DEFAULT のみ |
| 制御語彙の不足 | 低 | `src/domain/schemas.ts` で語彙の enum を管理。`src/utils/entityId.ts` は ID 生成のみ担当 |
| ストーリー化での LLM 幻覚 | 中 | 元メモ保持 + provenance + プロンプト厳格指示 |
| Guidance 移行時の互換性 | 中 | Phase 4-3 で旧形式（vibe_memories kind:guidance）の読み取りは維持 |
| confidence スコアの偏り | 低 | freshness 連動の時間減衰で長期未使用 task を自然に下げる |

### トレードオフ

| 観点 | 選択 | 代償 |
|------|------|------|
| シンプルさ vs 表現力 | entities/relations に統合 | 専用テーブルより型安全性が低い → 制御語彙 + Zod でカバー |
| 自動化 vs 透明性 | task 自動抽出あり | 誤抽出リスク → confidence: 0.3 で開始し実績で昇格 |
| 統合 vs 分離 | experience_logs は統合しない | 参照のみ → ストーリー化の入力として利用 |

### 非ゴール

| 非ゴール | 理由 |
|---------|------|
| 意味記憶の独立層 | 普遍的事実は LLM / Web 検索で十分。フィードバックループに参加できない |
| 新テーブルの追加 | entities/relations で表現可能 |
| LLM Context Window の管理 | Gnosis は長期記憶専門 |
| リアルタイム記憶更新 | 非同期バッチ基盤 |
| 手続き記憶の実行エンジン化 | 参照・注入用のみ |

---

## 11. 将来の拡張について

### 11-1. 記憶の忘却設計

- エピソード記憶: `referenceCount` が低く `createdAt` が古いものを LLM で要約→圧縮する定期バッチ
- 手続き記憶: `confidence < 0.1` の task を `metadata.deprecated: true` に自動フラグ

### 11-2. 多テナント・プロジェクト分離

- `when ← [context: プロジェクトA]` でプロジェクト固有の手続きを分離
- `scope: 'always'` + `when` の組み合わせでプロジェクト固有の暗黙知を実現

### 11-3. 評価基盤との統合

- confidence の推移をダッシュボードで可視化（`apps/monitor`）
- `record_outcome` の成功率を定量評価

### 11-4. Knowledge Federation

- 複数 Gnosis インスタンス間で手続き記憶を共有する federation 機能
