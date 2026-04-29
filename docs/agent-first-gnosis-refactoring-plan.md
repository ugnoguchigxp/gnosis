# Gnosis Agent-First リファクタリング改革書

> **ステータス**: Design Review Draft. 実装前にレビューを完了するための文書。  
> **作成日**: 2026-04-26  
> **目的**: Gnosis MCP を LLM が迷わず使える agent-first knowledge/review layer に再設計する  
> **比較対象**: `/Users/y.noguchi/Code/serena`  
> **実装方針**: この文書の review gates を満たすまで実装へ進まない。

---

## 1. 採用判断

### 1.1 結論

このリファクタリングは **採用するべき** である。

ただし、採用対象は「機能追加」ではなく、**LLM に見える公開ツール面の縮小・集約、structured knowledge store の導入、検索品質の強化、activation/onboarding 導線の強化、Gnosis knowledge を使った local/cloud LLM review** である。

Serena は named Markdown memory で LLM に「何を読むべきか」を判断させている。Gnosis は `.gnosis/memories/*.md` を導入せず、**DB 上の構造化 knowledge と explainable retrieval** で同等以上の体験を作る。

### 1.2 採用条件

実装へ進む前に、以下を設計決定として固定する。

1. Primary tools は原則 8 個以内に固定する。
2. 新規 tool を追加する場合、primary/internal/advanced のどれかを必ず定義する。
3. Knowledge は `entities` を source of truth とする。
4. `.gnosis/memories/*.md` は導入しない。
5. 登録時の必須入力は最小化し、`slug`, `title`, `kind`, `category`, `purpose`, `tags` は後段 enrichment で補完できるようにする。
6. 検索結果は named memory 相当の `slug`, `title`, `kind`, `category`, `purpose`, `snippet`, `reason` を返す。ただし、これらは登録時必須ではなく、未指定なら推定値を返す。
7. `record_task_note` の `kind` と `category` の意味を分離する。
8. `activate_project` は knowledge index summary、mode guidance、recommended next calls を必ず返す。
9. ナラティブ記憶は primary memory から除外し、ナラティブ統合 LLM コストを中核から外す。
10. code review / document review は primary capability として残し、local LLM と cloud LLM を選択可能にする。
11. 成功判定は数値目標で測る。

---

## 2. Serena から採用する設計原則

### 2.1 採用するもの

| Serena の設計 | Gnosis での採用方針 |
|---|---|
| `initial_instructions` が manual を返す | Gnosis も `initial_instructions` を持つ |
| `activate_project` が project info と memory list を返す | Gnosis の `activate_project` は knowledge index summary と next calls を返す |
| memory 名から relevance を判断させる | 検索結果に `slug`, `title`, `kind`, `category`, `purpose`, `reason` を返す。登録時にこれらを必須にはしない |
| context/mode で tool exposure を変える | client/mode 別に primary tools と advanced tools を制御する |
| onboarding で必要 memory を作らせる | `activate_project` の中で不足 knowledge を返し、必要時だけ onboarding guidance を返す |

### 2.2 採用しないもの

- Serena の symbolic code editing は複製しない。
- `.gnosis/memories/*.md` は導入しない。
- ナラティブ記憶を active memory として扱わない。
- 一般的な web research / fact accumulation としての KnowFlow は中核にしない。

Gnosis の責務は以下に絞る。

- structured project knowledge
- rule / lesson / procedure / skill / decision / risk / command recipe の再利用
- task trace
- code review / document review orchestration
- hook/review/command 由来の knowledge candidate 抽出
- explainable retrieval / indexing

---

## 3. 現状課題

### 3.1 First action が弱い

Gnosis には manual や rules はあるが、MCP tool として「最初に呼ぶべき入口」が弱い。LLM は作業開始時に Gnosis を呼ばず、通常の file/shell tools へ進みやすい。

### 3.2 Tool が多く、使い分けが LLM に委ねられている

LLM は以下を判断しなければならない。

- `search_memory` と `search_unified` の違い
- `query_procedure` と `recall_lessons` の違い
- `store_memory`, `record_outcome`, `task_checkpoint` の呼び時
- hook と manual memory の関係

この判断を LLM に委ねるほど、Gnosis の利用率は下がる。

### 3.3 検索結果が LLM にとって判断しづらい

Serena は named Markdown memory により、LLM が memory 名から関連性を推定できる。Gnosis は Markdown ファイルを増やさない代わりに、検索結果そのものを LLM が判断しやすい形にする必要がある。

検索結果に必要な情報:

- `slug`: 安定 ID
- `title`: 人間可読な名前
- `kind`: rule / lesson / procedure / skill / decision / risk など
- `category`: architecture / mcp / testing など
- `purpose`: 何のための knowledge か
- `snippet`: 判断に十分な短い抜粋
- `reason`: なぜこの query に返されたか
- `confidence`: 信頼度
- `evidence`: 根拠

### 3.4 ナラティブ記憶の費用対効果が低い

ナラティブ記憶は raw events を LLM でナラティブ化するため、継続運用するとコストが大きい。LLM にとって有用なのはナラティブではなく、抽出済みの rule / lesson / procedure / skill / decision / risk である。

ナラティブ記憶は active memory ではなく、廃止または一時的な provenance に限定する。

### 3.5 Hooks 由来データが低情報量になりやすい

hook candidates は metadata 羅列または ナラティブ化に寄りやすい。

必要なのは、後続 LLM が直接使える rule / lesson / procedure / skill / decision / risk の形である。

### 3.6 MCP client cache 問題が実害化している可能性がある

新 tool を作っても client が古い MCP metadata を掴んでいると使われない。doctor で visibility を検査する必要がある。

---

## 4. 設計決定事項

### 4.1 Public Tool Surface

LLM に通常推奨する primary tools は以下に固定する。

| Tier | Tool | 役割 |
|---|---|---|
| Primary | `initial_instructions` | Gnosis の使い方、first action、client guidance を返す |
| Primary | `activate_project` | project 状態、knowledge index summary、health、recommended next calls を返す |
| Primary | `start_task` | task trace を開始し、初期 context を取得する |
| Primary | `search_knowledge` | category 別に複数候補を検索する |
| Primary | `record_task_note` | rule/lesson/procedure/skill/decision/risk/command recipe を保存する |
| Primary | `finish_task` | outcome, checks, follow-ups, learned items を保存する |
| Primary | `review_task` | Gnosis knowledge を注入し、local/cloud LLM で code/doc review を実行する |

Primary tools は最大 8 個とする。これを超える場合は、既存 primary tool に吸収するか、advanced/internal に下げる。

### 4.2 Advanced/Internal Tool Policy

既存 tool は削除しない。ただし、通常 workflow では直接推奨しない。

| Tier | Tool Examples | 扱い |
|---|---|---|
| Advanced | `store_memory`, `search_memory`, `search_unified` | 互換性維持。primary tools の内部実装として使う |
| Advanced | `query_procedure`, `record_outcome` | 互換性維持。`search_knowledge` / `finish_task` に吸収する |
| Advanced | `get_task_context` | 互換性維持。primary からは外し、`search_knowledge` の preset/alias として扱う |
| Advanced | `task_checkpoint` | hooks/debug 用。通常は `start_task` / `finish_task` 経由 |
| Deprecated | 廃止済み体験統合ツール, 廃止済み体験統合ツール | 原則廃止。既存データ移行・監査用途のみ |
| Advanced | `export_knowledge_pack` | 必要時だけ Markdown/JSON に export する。source of truth ではない |
| Internal | graph low-level tools | primary API から利用する |
| Internal | hook candidate operations | candidate extraction pipeline 内で利用する |

### 4.3 Entity-Centric Knowledge Store Policy

`.gnosis/memories/*.md` は導入しない。source of truth は DB 上の `entities` である。

`lesson`, `decision`, `rule`, `procedure`, `skill`, `risk`, `command_recipe` は別ストアではなく、`entities.type` で表現する。これにより embedding search と graph traversal を同じ対象に対して実行できる。

Entity mapping:

| Concept | Storage |
|---|---|
| kind | `entities.type` |
| title | `entities.name` |
| content / summary | `entities.description` |
| category | `entities.metadata.category` |
| purpose | `entities.metadata.purpose` |
| tags | `entities.metadata.tags` |
| applicability | `entities.metadata.applicability` |
| validation criteria | `entities.metadata.validationCriteria` |
| evidence refs | `entities.metadata.evidence` |
| enrichment state | `entities.metadata.enrichmentState` |
| embedding | `entities.embedding` |
| confidence | `entities.confidence` |
| source/provenance | `entities.provenance` |

Registration input:

```typescript
type KnowledgeRegistrationInput = {
  content: string;
  title?: string;
  kind?: KnowledgeKind;
  category?: KnowledgeCategory;
  purpose?: string;
  tags?: string[];
  files?: string[];
  evidence?: EvidenceRef[];
  source?: 'manual' | 'hook' | 'review' | 'task' | 'import' | 'migration';
};
```

Canonical entity view:

```typescript
type KnowledgeEntity = {
  id: string;
  type: KnowledgeKind;
  name: string;
  description: string;
  embedding?: number[];
  confidence: number;
  scope: 'always' | 'on_demand';
  provenance?: string;
  metadata: {
    slug: string;
    category?: KnowledgeCategory;
    purpose?: string;
    tags?: string[];
    status: 'active' | 'draft' | 'needs_review' | 'rejected' | 'deprecated';
    applicability?: Applicability;
    validationCriteria?: string[];
    evidence?: EvidenceRef[];
    enrichmentState?: EnrichmentState;
    inferred?: {
      title?: boolean;
      kind?: boolean;
      category?: boolean;
      purpose?: boolean;
      tags?: boolean;
    };
  };
};
```

登録時に canonical entity の全フィールドを要求しない。`KnowledgeRegistrationInput` は `content` だけで受け付けられる。未指定の `title`, `kind`, `category`, `purpose`, `tags`, `slug` は background enrichment で補完する。

Enrichment state:

```typescript
type EnrichmentState =
  | 'pending'
  | 'enriched'
  | 'needs_review'
  | 'failed';
```

Enrichment が未完了の item でも保存は成功させる。ただし検索結果では、未補完項目に fallback を付ける。

Search/index layer:

- `entities` semantic search
- `entities.type` / `entities.metadata.category` filter
- lexical index
- vector index
- KG relation traversal
- category/kind filters
- applicability filters
- recency / confidence ranking
- evidence-aware ranking
- enrichment status filtering
- inferred tags / inferred category ranking

Relation policy:

| Relation | Meaning |
|---|---|
| `applies_to` | rule/lesson/procedure が対象 context に適用される |
| `depends_on` | procedure/skill/decision が前提 knowledge を持つ |
| `derived_from` | lesson/rule が review finding, hook event, raw event から導出された |
| `mitigates` | rule/procedure/risk mitigation が risk を緩和する |
| `contradicts` | knowledge 同士が矛盾する |
| `refines` | 新しい knowledge が古い knowledge を改善する |
| `has_step` | procedure が step entity を持つ |
| `evidence_for` | evidence/source が knowledge を支える |

Export policy:

- Markdown export は optional。
- export は review/human inspection 用であり source of truth ではない。
- import/export roundtrip はあってよいが、通常運用の前提にしない。

### 4.4 ナラティブ記憶 Policy

ナラティブ記憶は primary memory として扱わない。

方針:

1. `古い体験記録` は `KnowledgeKind` から外す。
2. 廃止済み体験統合ツール は primary/advanced workflow から外し、deprecated とする。
3. hook promotion は 古い体験記録を生成せず、`lesson`, `decision`, `rule`, `procedure`, `skill`, `risk`, `command_recipe` 候補を直接生成する。
4. 既存の古い体験記録データは即削除せず、移行期間中に lesson/decision/procedure 候補へ抽出する。
5. 新規 ナラティブ統合 LLM 呼び出しはデフォルト無効にする。
6. provenance が必要な場合は、古い体験記録ではなく raw event references / evidence links として保持する。

削除候補:

- 廃止済み体験統合ツール
- 旧 memoryType
- 古い体験記録 proxy entity
- 古い体験記録 provenance relation
- 廃止済み体験統合 cron / strict batch

### 4.5 Review Capability Policy

Gnosis は code review と document review を primary capability として残す。

目的は、local LLM または cloud LLM に単純レビューをさせることではなく、Gnosis knowledge を注入してレビューさせることである。

対象:

- code review
- implementation plan review
- design document review
- spec document review
- migration plan review

Provider:

- `local`: local LLM。低コスト・高速・日常レビュー向け。
- `openai`: cloud review。高難度・重要レビュー向け。
- `bedrock`: cloud review。AWS 統合・代替 cloud path 向け。

Review tool は、レビュー前に `search_knowledge` 相当の retrieval を内部で実行し、関連する rule / lesson / decision / procedure / skill / risk / command_recipe を review prompt に注入する。

### 4.6 新規 tool 追加ルール

新規 tool を追加する前に、以下を満たす必要がある。

1. 既存 primary tool に吸収できない理由を書く。
2. その tool が primary, advanced, internal のどれかを定義する。
3. primary tool の数が 8 個を超えないことを確認する。
4. description に `WHEN TO USE`, `DO NOT USE WHEN`, `WHAT IT RETURNS`, `TYPICAL NEXT TOOL` を書く。
5. 既存 client との互換性を壊さない。

### 4.7 Onboarding の扱い

`check_onboarding_performed`, `onboard_project`, `write_onboarding_memory` は primary tools として露出しない。

初期設計では、onboarding は `activate_project` と `record_task_note` に吸収する。

- `activate_project` は onboarding status と missing knowledge categories を返す。
- structured knowledge が不足している場合、`activate_project` は onboarding guidance を返す。
- LLM は `record_task_note` で onboarding knowledge を保存する。
- 将来、onboarding が複雑化した場合のみ advanced tool として分離する。

### 4.8 Contract Compatibility Policy

既存クライアント互換を維持するため、同名 tool の意味変更は禁止する。

1. 既存の `search_knowledge` は当面維持し、現行の knowFlow FTS 契約を壊さない。
2. 新設の entity-centric 検索 API は `search_knowledge_v2` として導入し、安定後に alias 切替を行う。
3. 旧 API を新 API の wrapper に置き換える場合でも、返却 shape は旧契約を維持する。
4. deprecate は最低 2 リリース期間を設け、description と docs で明示する。
5. `tools/list` contract test に「同名 tool の schema 不変」チェックを追加する。

### 4.9 API Naming Transition Plan

`search_knowledge` と `search_knowledge_v2` の移行は、以下の段階で実施する。

| Stage | Public API | 意味 |
|---|---|---|
| Stage 0 (現行) | `search_knowledge` | knowFlow FTS 検索（現行契約） |
| Stage 1 | `search_knowledge` + `search_knowledge_v2` | 旧契約維持 + 新契約併用 |
| Stage 2 | `search_knowledge` (alias to v2) + `search_knowledge_legacy` | 新契約を既定にしつつ退避経路を維持 |
| Stage 3 | `search_knowledge` | v2 契約のみ（legacy 廃止） |

Cutover 条件:

1. `search_knowledge_v2` の契約テスト合格率 100%。
2. wrapper 経由を含む既存クライアント回帰テスト合格率 99% 以上。
3. 2 リリース期間の deprecate 告知を完了。
4. monitor/doctor で stale metadata の `suspected_stale` が許容範囲内（false positive 10% 以下）。

---

## 5. First-Call Enforcement

### 5.1 問題

`initial_instructions` の tool description に `IMPORTANT` と書くだけでは不十分である。MCP client が description を読まない、古い cache を掴む、または LLM が無視する可能性がある。

### 5.2 方針

Gnosis は複数の導線で first call を促す。

1. `initial_instructions` description に first-call instruction を書く。
2. `activate_project` description に first-call instruction を書く。
3. setup rules に `activate_project` first-call を書く。
4. `activate_project` は knowledge index summary と recommended next calls を必ず返す。
5. `start_task`, `search_knowledge`, `record_task_note`, `finish_task`, `review_task` は、project 未活性時でも失敗せず、軽量 activation warning と inferred project context を返す。
6. `doctor` は stale client cache の不整合シグナルを検出し、根拠付きで報告する。

### 5.3 `activate_project` Return Contract

```typescript
type ActivateProjectResult = {
  project: {
    name: string;
    root: string;
    languages: string[];
  };
  health: {
    db: 'ok' | 'degraded' | 'unavailable';
    hooks: 'enabled' | 'disabled';
    toolVersion: string;
    warnings: string[];
  };
  onboarding: {
    status: 'complete' | 'missing' | 'partial';
    missingKinds: KnowledgeKind[];
    missingCategories: KnowledgeCategory[];
    guidance?: string;
  };
  knowledgeIndex: {
    totalActive: number;
    byKind: Record<KnowledgeKind, number>;
    byCategory: Record<KnowledgeCategory, number>;
    projectKeywords: string[];
    projectCharacteristics: Array<{
      label: string;
      reason: string;
      confidence: number;
    }>;
    representativeEntities: Array<{
      entityId: string;
      title: string;
      kind: KnowledgeKind;
      category: KnowledgeCategory;
      reason: string;
    }>;
    topItems: Array<{
      entityId: string;
      slug: string;
      title: string;
      kind: KnowledgeKind;
      category: KnowledgeCategory;
      purpose: string;
      reason: string;
      updatedAt: string;
    }>;
  };
  recommendedNextCalls: Array<{
    tool: string;
    reason: string;
  }>;
  instructions: string;
};
```

### 5.4 `doctor` Stale Metadata Contract

`doctor` は「古い cache を確定判定」するのではなく、「不整合シグナル」を返す。

```typescript
type DoctorStaleMetadataSignal = {
  status: 'ok' | 'suspected_stale' | 'unknown';
  reasons: Array<
    | 'missing_required_primary_tool'
    | 'tool_schema_version_mismatch'
    | 'tool_description_version_mismatch'
    | 'client_snapshot_unavailable'
  >;
  evidence: Array<{
    tool: string;
    expectedVersion?: string;
    observedVersion?: string;
    detail: string;
  }>;
};
```

`doctor` は `status` と `reasons` を必ず返し、false positive を減らすため `evidence` を必須にする。

---

## 6. Entity-Centric Knowledge Design

### 6.1 Source of Truth

`entities` を source of truth とする。

DB/vector/KG は分離されたものではなく、同じ knowledge entity の複数 index/view として扱う。

- `entities` row: canonical record
- vector index: semantic retrieval
- lexical index: exact/search keyword retrieval
- `relations`: dependency/applicability/provenance traversal
- optional export: human inspection only

### 6.2 KnowledgeKind and KnowledgeCategory

```typescript
type KnowledgeKind =
  | 'project_doc'
  | 'rule'
  | 'procedure'
  | 'skill'
  | 'decision'
  | 'lesson'
  | 'observation'
  | 'risk'
  | 'command_recipe'
  | 'reference';

type KnowledgeCategory =
  | 'project_overview'
  | 'architecture'
  | 'mcp'
  | 'hook'
  | 'memory'
  | 'workflow'
  | 'testing'
  | 'operation'
  | 'debugging'
  | 'coding_convention'
  | 'security'
  | 'performance'
  | 'reference';
```

例:

| kind | category | 意味 |
|---|---|---|
| `decision` | `architecture` | architecture に関する設計決定 |
| `lesson` | `mcp` | MCP 運用上の教訓 |
| `rule` | `coding_convention` | 常に守るべき規約 |
| `procedure` | `workflow` | 再現可能な作業手順 |
| `skill` | `debugging` | 特定場面で使うノウハウ |
| `command_recipe` | `testing` | test 実行手順 |
| `risk` | `hook` | hook 周りのリスク |
| `project_doc` | `project_overview` | project 概要 |

### 6.3 Entity Search Result Quality Requirements

Markdown ファイル名の代わりに、検索結果自体が LLM の判断材料になる必要がある。

`search_knowledge` と `get_task_context` は `entities` を検索し、各 hit に以下を返す。

- `entityId`
- `slug`
- `title`
- `kind`
- `category`
- `purpose`
- `snippet`
- `reason`
- `confidence`
- `applicabilityMatch`
- `evidenceSummary`
- `lastUsedAt`
- `updatedAt`

Quality bar:

- title は 80 文字以内。未指定なら enrichment または fallback で生成する。
- purpose は 1 文。未指定なら enrichment または fallback で生成する。
- snippet は 300 文字以内。
- reason は retrieval reason を明示する。例: vector similarity, lexical match, graph neighbor, applicability match。
- category group ごとに `suggestedUse` を返す。
- low confidence / deprecated / rejected は通常結果から除外する。
- kind/category/tags は登録時必須ではない。検索時には enrichment 済みの値、または `inferred` と明示した推定値を返す。
- 推定値を返す場合は `inferenceConfidence` を付ける。

### 6.4 Background Enrichment Policy

登録ルールは厳しくしない。代わりに background enrichment が不足情報を補完する。

Enrichment inputs:

- content
- source
- files
- task context
- review findings
- hook metadata
- command result

Enrichment outputs:

- slug
- title
- kind
- category
- purpose
- tags
- applicability
- validationCriteria
- evidenceSummary
- related items

Enrichment triggers:

- `record_task_note` 後の background job
- `finish_task` 後の background job
- hook candidate creation 後
- review_task の `suggestedNotes` 生成後
- periodic cron
- manual `reindex_knowledge` advanced tool

Cron 方針:

- cron は tag/category/purpose を後付けするために使う。
- cron は active knowledge を勝手に強い rule に昇格させない。
- confidence が低い補完結果は `needs_review` にする。
- enrichment は cheap local model を default とし、cloud は使わない。

### 6.5 Entity Indexing Policy

index は canonical entity から生成する。

- entity id
- entity type
- entity name
- entity description
- slug
- title
- kind
- category
- purpose
- content
- status
- tags
- files
- applicability
- validation criteria
- evidence refs
- enrichment state
- inferred fields
- embeddings if enabled
- graph relations if enabled

index 更新は以下で行う。

- `record_task_note` 実行時
- `finish_task` 実行時
- candidate promotion 時
- enrichment cron 完了時
- `activate_project` 実行時の軽量 stale check
- `doctor` または `reindex_knowledge` advanced tool

---

## 7. Primary Tool Contracts

### 7.1 `search_knowledge`

検索系機能は `entities` 検索に統一する。`search_memory`, `search_unified`, `query_procedure` を LLM に選ばせず、`search_knowledge` が entity semantic search, lexical search, graph traversal, procedure retrieval を内部で束ねる。

```typescript
type SearchKnowledgeInput = {
  query?: string;
  preset?: 'task_context' | 'project_characteristics' | 'review_context' | 'procedures' | 'risks';
  kinds?: KnowledgeKind[];
  categories?: KnowledgeCategory[];
  filterMode?: 'and' | 'or';
  filters?: {
    kinds?: { mode?: 'and' | 'or'; values: KnowledgeKind[] };
    categories?: { mode?: 'and' | 'or'; values: KnowledgeCategory[] };
    tags?: { mode?: 'and' | 'or'; values: string[] };
    files?: { mode?: 'and' | 'or'; values: string[] };
    relationTypes?: { mode?: 'and' | 'or'; values: string[] };
  };
  projectRoot?: string;
  files?: string[];
  taskId?: string;
  intent?: 'plan' | 'edit' | 'debug' | 'review' | 'finish';
  limitPerCategory?: number;
  maxCategories?: number;
  includeContent?: 'summary' | 'snippet' | 'full';
  grouping?: 'by_category' | 'flat';
  traversal?: {
    enabled?: boolean;
    maxDepth?: number;
    relationTypes?: string[];
  };
};

type SearchKnowledgeResult = {
  groups: Array<{
    category: KnowledgeCategory;
    categoryReason: string;
    suggestedUse: string;
    hits: Array<{
      entityId: string;
      slug: string;
      title: string;
      kind: KnowledgeKind;
      category: KnowledgeCategory;
      purpose: string;
      score: number;
      confidence: number;
      reason: string;
      snippet: string;
      applicabilityMatch?: string;
      evidenceSummary?: string;
      matchSources: Array<'vector' | 'lexical' | 'graph' | 'applicability' | 'recency' | 'confidence'>;
      graphContext?: Array<{
        entityId: string;
        relationType: string;
        title: string;
        kind: KnowledgeKind;
      }>;
      updatedAt?: string;
    }>;
  }>;
  flatTopHits?: Array<{
    entityId: string;
    title: string;
    kind: KnowledgeKind;
    category: KnowledgeCategory;
    score: number;
  }>;
  suggestedNextAction: 'use_category' | 'read_hit' | 'start_task' | 'record_task_note' | 'refine_query';
};
```

Default:

- `grouping: 'by_category'`
- `limitPerCategory: 3`
- `maxCategories: 5`
- `includeContent: 'snippet'`
- `traversal.enabled: true`
- `traversal.maxDepth: 1`
- `filterMode: 'or'`

LLM は category group を見て、どの種類の情報を使うか判断する。Gnosis は retrieval method の選択を隠蔽する。検索対象は常に entity であり、vector hit と graph neighbor を同じ result shape で返す。

Boolean filter policy:

- LLM は `and` / `or` を明示して検索条件を指定できる。
- top-level `filterMode` は `kinds`, `categories`, `tags`, `files` などの大枠の結合方法を表す。
- 各 filter 内の `mode` は、その filter 内の値同士の結合方法を表す。
- default は recall 重視の `or`。
- review や strict retrieval では `and` を使える。
- 複雑な query language は導入せず、LLM が安全に叩ける構造化 filter に留める。

Preset policy:

- `task_context`: 旧 `get_task_context` 相当。taskId, files, intent から query を組み立てる。
- `project_characteristics`: project keywords, representative entities, frequent categories を返す。
- `review_context`: review_task 内部 retrieval と同等。
- `procedures`: procedure / skill / command_recipe を優先する。
- `risks`: risk / lesson / rule を優先する。

`query` が空でも `preset` があれば検索できる。これにより「プロジェクトの特徴を大量のキーワードや代表 entity から取る」用途も `search_knowledge` に統合する。

### 7.2 `record_task_note`

`record_task_note` は保存系を集約する。

```typescript
type RecordTaskNoteInput = {
  taskId?: string;
  content: string;
  kind?: KnowledgeKind;
  category?: KnowledgeCategory;
  title?: string;
  purpose?: string;
  tags?: string[];
  evidence?: EvidenceRef[];
  files?: string[];
  appliesWhen?: string[];
  doesNotApplyWhen?: string[];
  validationCriteria?: string[];
  confidence?: number;
  source?: 'manual' | 'task' | 'hook' | 'review' | 'onboarding' | 'import';
  strict?: boolean;
};
```

Rules:

- `content` だけは必須。
- `kind`, `category`, `title`, `purpose`, `tags` は任意。
- 未指定項目は background enrichment で補完する。
- `strict: true` の場合のみ、kind/category 別 validation を強く適用する。
- `strict` default は `false`。
- `kind='lesson'` と明示された場合は `appliesWhen` と `evidence` を推奨するが、欠けていても draft として保存できる。
- `kind='decision'` と明示された場合は trade-offs または alternatives を推奨する。
- `kind='command_recipe'` と明示された場合は command と expected result を推奨する。
- `kind='rule'` と明示された場合は enforcement condition と validation criteria を推奨する。
- `kind='procedure'` または `kind='skill'` と明示された場合は steps, appliesWhen, expected outcome を推奨する。
- 補完に失敗した item は `needs_review` とし、検索結果では低順位または除外する。

### 7.3 `review_task`

`review_task` は Gnosis knowledge を使った LLM review の primary tool である。

```typescript
type ReviewTaskInput = {
  targetType: 'code_diff' | 'document' | 'implementation_plan' | 'spec' | 'design';
  target: {
    diff?: string;
    filePaths?: string[];
    content?: string;
    documentPath?: string;
  };
  provider?: 'local' | 'openai' | 'bedrock';
  reviewMode?: 'fast' | 'standard' | 'deep';
  projectRoot?: string;
  focus?: Array<'correctness' | 'security' | 'maintainability' | 'architecture' | 'testability' | 'alignment'>;
  useKnowledge?: boolean;
  maxKnowledgeItems?: number;
};

type ReviewTaskResult = {
  providerUsed: 'local' | 'openai' | 'bedrock';
  knowledgeUsed: Array<{
    slug: string;
    kind: KnowledgeKind;
    category: KnowledgeCategory;
    title: string;
    reason: string;
  }>;
  findings: Array<{
    severity: 'critical' | 'major' | 'minor' | 'info';
    title: string;
    body: string;
    file?: string;
    line?: number;
    evidence?: string[];
    relatedKnowledge?: string[];
  }>;
  summary: string;
  suggestedNotes?: Array<{
    kind: KnowledgeKind;
    category: KnowledgeCategory;
    title: string;
    purpose: string;
    content: string;
  }>;
};
```

Rules:

- `useKnowledge` default は `true`。
- review 前に rule / lesson / decision / procedure / skill / risk を検索して prompt に注入する。
- code review では diff と関連 file paths を retrieval query に含める。
- document review では heading, claim, decision, requirement を retrieval query に含める。
- `local` は日常レビューの default。
- `openai` / `bedrock` は high-risk, deep review, user request 時に使う。
- provider の違いに関係なく、knowledgeUsed を返す。
- review から得た再利用可能な知見は `suggestedNotes` として返し、自動保存はしない。保存は `record_task_note` に委ねる。

### 7.4 Review API Consolidation Policy

review API の責務重複を避けるため、移行期間中は以下の統合ルールを適用する。

1. 新規の統合入口は `review_task` とする。
2. 既存の `review`, `review_document`, `review_spec_document`, `review_implementation_plan` は当面維持する。
3. 上記既存 API は段階的に `review_task` の wrapper とし、既存 output contract は維持する。
4. `review_task.targetType` と既存 API の対応表を docs に固定する。
5. 互換期間終了後にのみ deprecated 扱いへ進める。

---

## 8. Automated Knowledge Candidate Extraction

### 8.1 方針

自動取得機能のターゲットは、一般的な事実収集や ナラティブ生成ではなく、LLM が再利用できる knowledge candidate の抽出に絞る。

抽出対象:

- `rule`
- `lesson`
- `procedure`
- `skill`
- `decision`
- `risk`
- `command_recipe`

入力源:

- hooks
- review findings
- failed commands
- successful fixes
- implementation plans
- design/spec documents
- user-approved notes

KnowFlow の一般的な web research / fact accumulation は中核から外す。必要な場合のみ、rule/procedure/skill 候補を外部情報から生成する advanced workflow として残す。

### 8.2 Candidate Schemas

#### Rule

```markdown
# Rule: <short title>

## Rule

## Applies When

## Does Not Apply When

## Validation Criteria

## Evidence
```

#### Procedure / Skill

```markdown
# Procedure: <short title>

## Goal

## Applies When

## Steps

## Expected Outcome

## Failure Modes

## Evidence
```

#### Lesson

```markdown
# Lesson: <short title>

## Trigger

## Mistake / Risk

## Diagnosis

## Fix

## Prevention

## Applies When

## Does Not Apply When

## Evidence

## Confidence
```

#### Decision

```markdown
# Decision: <short title>

## Context

## Options Considered

## Chosen Option

## Trade-offs

## Files / Components

## Reversal Conditions
```

### 8.3 Quality Gate

保存前に以下を検査する。

- `kind` と `category` がある。
- `purpose` がある、または enrichment で生成可能である。
- `Context` または `Problem` がある。
- `Fix`, `Outcome`, `Chosen Option`, `Rule`, `Steps` のいずれかがある。
- `Evidence` がある。
- 具体的な file path または command が 1 つ以上ある。
- 文字数が短すぎない。
- metadata だけで本文が構成されていない。
- ナラティブ本文 だけで本文が構成されていない。

低品質候補は `draft`, `needs_review`, `rejected` として保存し、active knowledge には昇格しない。登録自体は失敗させず、昇格条件だけを厳しくする。

### 8.4 Extraction Runtime Policy (Safety)

自動抽出パイプラインは初期フェーズではデフォルト無効にする。

1. cron / background 起因の candidate extraction は `GNOSIS_ENABLE_AUTOMATION=true` 明示時のみ実行する。
2. 手動実行（tool call / CLI）を優先し、品質ゲートを先に安定化する。
3. Phase G の評価完了まで、昇格処理は段階的ロールアウト（feature flag）で有効化する。
4. 不具合時は extraction を即停止できる kill switch を必須化する。

---

## 9. Context / Mode Design

### 9.1 Contexts

| Context | 方針 |
|---|---|
| `codex` | shell/read/edit は Codex native を使う。Gnosis は knowledge/procedure/review/task trace に集中する |
| `cursor` | stale MCP cache 検出と first-call guidance を強める |
| `claude` | explicit instructions と activation guidance を強める |
| `generic` | primary tools のみを推奨する |

### 9.2 Modes

| Mode | 方針 |
|---|---|
| `planning` | `activate_project`, `search_knowledge` を推奨 |
| `editing` | `start_task`, `record_task_note`, `finish_task` を推奨 |
| `review` | `review_task`, `search_knowledge` を推奨。local/cloud provider を選択可能 |
| `onboarding` | `activate_project` が不足 knowledge を返し、`record_task_note` で保存 |
| `no_memory` | 書き込み系を推奨しない |

---

## 10. MCP Visibility / Cache Plan

### 10.1 Doctor Checks

`doctor` は以下を検査する。

1. 実 MCP server の `tools/list`。
2. expected primary tools の存在。
3. tool metadata version。
4. Cursor cache 上の tool metadata。
5. stale cache の疑い。
6. hooks enabled/disabled。
7. DB availability。
8. knowledge index freshness。

### 10.2 Required Primary Tools

`doctor` は以下を expected primary tools として検査する。

- `initial_instructions`
- `activate_project`
- `start_task`
- `search_knowledge`
- `record_task_note`
- `finish_task`
- `review_task`

### 10.3 Automation and Rollout Guards

実装中の暴発を防ぐため、常時起動系は次を必須とする。

1. default は automation OFF（明示的に有効化しない限り cron/background は起動しない）。
2. `GNOSIS_ENABLE_AUTOMATION=true` を唯一の有効化スイッチとする。
3. launchd / worker / scheduled scripts は同一ガードに従う。
4. doctor は automation 状態（on/off）を health payload に表示する。
5. rollback 時は automation を OFF に戻すだけで停止できることを受け入れ条件にする。

---

## 11. Evaluation and Adoption Gates

### 11.1 Metrics

| Metric | Target |
|---|---:|
| 新規 session で `activate_project` が最初の 3 tool call 以内に呼ばれる率 | 70% 以上 |
| Primary tool usage rate | 70% 以上 |
| Low-level direct tool usage rate | 30% 未満 |
| `search_memory` / `search_unified` / `query_procedure` の直接利用率 | 20% 未満 |
| `finish_task` completion rate for started tasks | 60% 以上 |
| active knowledge に昇格する candidates の quality gate 通過率 | 80% 以上 |
| stale metadata 不整合シグナルの検知率（シミュレーションケース） | 95% 以上 |
| stale metadata 不整合シグナルの false positive 率 | 10% 以下 |
| 通常 workflow で推奨される tool 数 | 8 個以内 |
| 廃止済み体験統合 LLM 呼び出し | default 0 |
| search result が `title/purpose/reason/snippet` を含む率 | 100% |
| search result が `entityId` と `matchSources` を含む率 | 100% |
| minimal `record_task_note` が保存成功する率 | 100% |
| enrichment cron が pending item に tag/category/purpose を補完する率 | 90% 以上 |
| review_task で knowledgeUsed が 1 件以上返る率 | 80% 以上 |
| code/document review で local provider が正常完了する率 | 90% 以上 |
| cloud review が user request または high-risk condition に限定される率 | 95% 以上 |
| 既存 review API wrapper 経由での互換成功率 | 99% 以上 |

### 11.2 Evaluation Scenarios

1. 新規 task 開始時に `activate_project` が呼ばれるか。
2. `activate_project` が knowledge index summary と recommended next calls を返すか。
3. `search_knowledge` が category 別に複数 hit を返すか。
4. 各 hit が `entityId`, `slug`, `title`, `kind`, `category`, `purpose`, `snippet`, `reason`, `matchSources` を持つか。
5. LLM が category group を見て利用対象を選べるか。
6. `search_knowledge` が vector hit と graph neighbor を同じ result shape で返せるか。
7. `search_knowledge` が `and` / `or` filter を LLM 指定で実行できるか。
8. `record_task_note` が `content` だけで保存できるか。
9. enrichment cron が `kind`, `category`, `purpose`, `tags` を後付けできるか。
10. `finish_task` が outcome と learned items を保存できるか。
11. hooks 由来 candidate が metadata 羅列や ナラティブ本文 のまま active knowledge にならないか。
12. stale metadata シミュレーションケースで doctor が `suspected_stale` と根拠を返せるか。
13. DB unavailable 時に明確な degraded response が返るか。
14. `review_task` が code diff に Gnosis knowledge を注入して local review できるか。
15. `review_task` が document / plan / spec に Gnosis knowledge を注入して review できるか。
16. `review_task` が `openai` / `bedrock` provider を明示指定できるか。
17. `search_knowledge` 旧契約が壊れていないか（schema/semantic 回帰なし）。
18. `search_knowledge_v2` が entity-centric result shape を満たすか。
19. 既存 review API が wrapper 化後も同一契約で応答するか。
20. 古い体験記録の廃止移行中に hooks / monitor / record_outcome の回帰がないか。

### 11.3 Go / No-Go Gate

実装フェーズへ進む前に、以下をレビューで合意する。

- Primary tools 8 個の確定。
- advanced/internal tools の分類。
- structured knowledge schema。
- source-of-truth 方針。
- `kind` / `category` vocabulary。
- `search_knowledge` response shape。
- `record_task_note` minimal input と enrichment rules。
- `review_task` provider policy。
- first-call enforcement 方針。
- metrics target。
- compatibility matrix（旧 API / 新 API / alias 切替条件）。
- 古い体験記録依存コンポーネント移行順（hooks / monitor / CLI / record_outcome）。
- contract test 移行計画（旧契約保持 + 新契約追加）。

### 11.4 Compatibility and Test Gates

移行期間は「旧契約維持」と「新契約追加」を同時に検証する。

1. `tools/list` snapshot test を導入し、旧 tool schema の不変を検証する。
2. `search_knowledge_legacy` 旧契約テストを固定し、新規 `search_knowledge`（entity-centric）の契約テストを別途追加する。
3. review 系は既存 API と `review_task` の結果整合テストを追加する。
4. 古い体験記録依存系（hooks / monitor / record_outcome）は feature flag 下で A/B テストする。
5. deprecated 指定後も互換期間中は CI で旧 API 契約テストを継続する。

### 11.5 Implementation Entry Checklist

実装フェーズへ進む前に、以下がすべて `done` であること。

- [x] API naming transition（`search_knowledge` を新契約に上書き、旧契約は `search_knowledge_legacy`）を実装方針として確定済み。
- [x] `search_knowledge`（新契約）/`search_knowledge_legacy`（旧契約）の責務分離が docs と contract tests に反映済み。
- [x] automation guard（default OFF, single enable flag）が server/worker/scripts で統一済み。
- [x] 古い体験記録依存コンポーネント inventory が作成済みで、移行順序が確定済み。
- [x] review API wrapper 戦略（入力/出力互換）がテスト観点込みで確定済み。
- [x] doctor の stale metadata 判定ロジックと evidence shape がテスト可能な形で定義済み。

---

## 12. 実装フェーズ案

この章は実装開始後の順序案であり、現時点では実装しない。

### Phase A: Design Lock

- primary/advanced/internal tool inventory を確定する。
- structured knowledge schema を確定する。
- `kind` / `category` vocabulary を確定する。
- enrichment rules と cron policy を確定する。
- search result quality contract を確定する。
- 古い体験記録の廃止範囲と移行方針を確定する。
- review provider policy を確定する。
- evaluation scenarios を固定する。
- compatibility matrix（旧 API / 新 API / wrapper / deprecate 時期）を確定する。
- 古い体験記録依存コンポーネント inventory（hooks / monitor / CLI / scripts / record_outcome）を確定する。

### Phase B: MCP Visibility and Runtime Health

- `doctor` に MCP tool visibility check を追加する。
- stale metadata 不整合シグナル判定（status/reasons/evidence）を追加する。
- `get_runtime_status` 相当の health payload を整備する。
- client metadata snapshot 未取得時の `unknown` フォールバックを実装する。

### Phase C: Activation and Structured Knowledge Store

- `initial_instructions` を追加する。
- `activate_project` を追加する。
- structured knowledge schema / repository / indexer を追加する。
- DB unavailable 時は degraded response を明確に返す。

### Phase D: Tool Surface Consolidation

- primary tools を 8 個以内に固定する。
- low-level tools に `Advanced/low-level` description を付与する。
- context/mode で recommended tools を変える。

### Phase E: Task Workflow and Review Tools

- `start_task` を追加する。
- `search_knowledge` を entity-centric 契約へ移行し、旧契約は `search_knowledge_legacy` へ退避する。
- `record_task_note` を追加する。
- `finish_task` を追加する。
- `review_task` を追加し、local/openai/bedrock provider と knowledge injection を実装する。
- 既存 review APIs を段階的に `review_task` wrapper 化し、互換契約テストを通す。

### Phase F: ナラティブ記憶 Deprecation and Candidate Extraction

- 廃止済み体験統合 をデフォルト無効化する。
- 廃止済み体験統合ツール を deprecated にする。
- 既存の古い体験記録データから lesson/decision/procedure 候補を抽出する migration を用意する。
- hook/review/command candidates を rule/lesson/procedure/skill/decision/risk/command_recipe に変換する。
- quality gate を追加する。
- rejected/draft/active 状態を導入する。
- hooks / monitor / CLI / record_outcome の 古い体験記録依存処理を段階移行し、feature flag で切替える。

### Phase G: Evaluation and Iteration

- metrics を収集する。
- evaluation scenarios を実行する。
- primary tool usage と low-level direct usage を測定する。
- search result quality を測定する。
- thresholds を満たさない場合は tool descriptions、activation guidance、retrieval ranking を調整する。

### Phase H: Rollout / Kill Switch / Rollback

- rollout は `dev -> internal -> default` の段階で実施する。
- enable 条件は feature flag で制御し、段階ごとに観測指標を確認する。
- 異常時は `GNOSIS_ENABLE_AUTOMATION=false` と feature flags OFF で即時停止する。
- rollback は DB migration rollback と API alias rollback を分けて運用する。
- rollback 手順は runbook 化し、doctor から参照可能にする。

---

## 13. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---:|---|
| primary tools が増えすぎる | LLM が迷う | 8 個上限を Go/No-Go Gate にする |
| advanced tools を残しすぎる | LLM が直接使い続ける | description に `Advanced/low-level` を明記し、recommended list から外す |
| Markdown memory を使わないことで LLM が一覧判断しづらい | 利用率が上がらない | `activate_project` の knowledge index summary と explainable search hits を強化する |
| DB が使えないと knowledge retrieval が落ちる | degraded 時の価値が下がる | 明確な degraded response、optional export/cache、doctor を用意する |
| `kind` と `category` が混同される | 検索・保存品質が落ちる | kind=形式、category=話題領域として schema と validation を分ける |
| 登録ルールを厳しくしすぎて LLM が保存しなくなる | knowledge が増えない | `content` のみで保存可能にし、enrichment cron で後付けする |
| enrichment が誤分類する | 検索品質が落ちる | inferenceConfidence、needs_review、human/LLM review、再分類を用意する |
| `initial_instructions` が無視される | 利用率が上がらない | activation warning、setup rules、recommended next calls、doctor を併用する |
| candidate extraction が低品質 | knowledge 汚染 | quality gate と draft/rejected state を導入する |
| 古い体験記録を廃止しすぎて provenance が失われる | なぜその lesson が作られたか追えない | raw event references / evidence links を残す |
| cloud review のコストが増える | 運用費が増える | default は local、cloud は明示指定または high-risk condition に限定する |
| review が Gnosis knowledge を使わない | 差別化が消える | `knowledgeUsed` を必須返却し、利用率を評価 metric にする |
| Serena の模倣に寄りすぎる | Gnosis の強みが薄れる | file memory/code editing ではなく structured knowledge/review に集中する |

---

## 14. Review Questions

他の LLM や人間 reviewer には以下を重点的に確認させる。

1. Primary tools 8 個は多すぎないか、少なすぎないか。
2. `.gnosis/memories/*.md` を導入しない判断は妥当か。
3. structured knowledge store は source of truth として十分か。
4. `search_knowledge` の result shape は named Markdown memory と同等以上に LLM が判断しやすいか。
5. `search_knowledge` を primary に残す判断は妥当か。
6. 登録時に `content` だけを必須にする設計は十分に使いやすいか。
7. enrichment cron で `tags`, `kind`, `category`, `purpose` を後付けする方針は妥当か。
8. `kind` と `category` の vocabulary は実運用に耐えるか。
9. `activate_project` の knowledge index summary は first action として十分か。
10. onboarding を独立 tool にせず `activate_project` / `record_task_note` に吸収する方針は妥当か。
11. hook/review/command candidate quality gate は厳しすぎないか、緩すぎないか。
12. ナラティブ記憶 実装を deprecated / 削除候補にする判断は妥当か。
13. `review_task` を primary に残し、local/openai/bedrock provider を持たせる設計は妥当か。
14. review prompt に注入すべき knowledge kinds は十分か。
15. cloud review の発火条件はコスト管理として妥当か。
16. adoption metrics の threshold は妥当か。
17. 実装フェーズ順は手戻りを最小化できるか。
