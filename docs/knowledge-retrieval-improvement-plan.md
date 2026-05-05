# Knowledge Retrieval 改善計画

## 目的

`search_knowledge` / `agentic_search` が、登録済み知識を実用的に取得できる状態にする。

この計画は検索品質の最小改善に限定する。`embedding daemon + 専用queue` は既に別計画で扱っており、この文書では扱わない。

## 実装後の前提

- embedding daemon は常駐化済み。
- embedding 実行queue は LLM queue から分離済み。
- `search_knowledgeV2` は実検索へ接続済み。
- `searchEntityKnowledgeDetailed()` は query embedding を作り、entities の vector / exact / full-text / direct text 候補を merge する。
- embedding / vector search が失敗しても exact / full-text / direct text / recent fallback の状態が telemetry で分かる。

つまり、この計画の主課題は「embedding を使うかどうか」ではなく、**vector / exact / full-text / metadata の結果をどう統合し、検証可能にするか**である。

## やらないこと

- `agentic_search` のユーザー向け出力 schema を増やさない。
- `reason`, `whyNow`, `nextCheck` のような説明用フィールドを追加しない。
- 低品質な候補を未選別で prompt に混ぜない。
- Gemma4 に知識蒸留や高度な候補採用判断を任せない。
- failure pattern 照合を主軸にしない。
- similarity threshold を先に厳しくしない。
- `review_task` 全面改修はこの計画に含めない。

## 改善方針

### 1. 検索候補を merge する

改修前は vector search がヒットすると、その結果だけで返りやすかった。
これを次の候補群を集めてから merge する形にする。

- vector: query embedding による situation search
- exact: entity id / name / metadata の完全一致
- full-text: エラー名、ツール名、ファイル名、関数名などの語句一致
- recent fallback: 候補0件時の直近 `lesson` / `procedure` / `rule` / `skill`

初期段階では DB 側 threshold で候補を捨てない。`topK` を広めに取り、アプリ側で重複排除と並び替えを行う。

### 2. query text を整形する

query embedding に渡す文字列は、ユーザー文をそのまま使いすぎない。

検索用 query text は以下を短く連結する。

- task goal
- symptom / failure mode
- target files or modules
- change types
- technologies
- intent

ただし、LLM による query rewrite はまだ入れない。まず deterministic な整形で十分にする。

### 3. metadata を検索に使う

`record_task_note` で保存する知識に、検索用 metadata を持たせる。

優先する metadata は以下。

- `intent`
- `changeTypes`
- `technologies`
- `files`
- `kind`
- `category`
- `triggerPhrases`
- `appliesWhen`

metadata は絞り込みや boost に使う。semantic text は embedding 検索に使う。

### 4. 疎なコーパスでは成功手順を優先する

初期コーパスでは failure pattern より、成功体験・手順・skill の方が再利用しやすい。

優先順位は以下。

1. `procedure`
2. `skill`
3. `rule`
4. `lesson`
5. Golden Path / success-path
6. failure evidence

failure evidence は主に severity 確認に使い、候補検索の主軸にはしない。

### 5. telemetry は内部最小にする

検索が効いているかを検証するため、内部ログまたは戻り値の raw 確認用フィールドに最小 telemetry を入れる。

必要な情報は以下。

- `queryText`
- `vectorHitCount`
- `exactHitCount`
- `fullTextHitCount`
- `directTextHitCount`
- `recentFallbackUsed`
- `embeddingStatus`
- `mergedCandidateCount`

ユーザー向け `agentic_search` 回答には出さない。`search_knowledge` は raw 候補確認用なので、必要最小限の score と retrieval info は返してよい。

## 実装順

### Step 1: search merge の最小実装

対象:

- `src/services/entityKnowledge.ts`
- `src/services/agentFirst.ts`
- `src/services/agenticSearch/tools/knowledgeSearch.ts`

作業:

- vector / exact / full-text / recent fallback を個別に取得する。
- id 単位で重複排除する。
- score と source を保持する。
- `search_knowledge` の `flatTopHits` に統合結果を返す。

### Step 2: query text builder を追加する

対象:

- `src/services/agentFirst.ts`
- 必要なら `src/services/knowledgeRetrieval/*`

作業:

- `taskGoal`, `query`, `files`, `changeTypes`, `technologies`, `intent` から検索用 query text を作る。
- query text は短く保つ。
- LLM rewrite は入れない。

### Step 3: record metadata を強化する

対象:

- `src/services/agentFirst.ts`
- `recordTaskNote()` 周辺

作業:

- `record_task_note` 入力の `kind`, `category`, `files`, `tags`, `metadata` を検索用 metadata として保存する。
- `triggerPhrases` / `appliesWhen` が渡された場合は保持する。
- 既存保存形式と互換を壊さない。

### Step 4: telemetry を固定する

対象:

- `search_knowledgeV2`
- `knowledge_search`

作業:

- 候補取得数と fallback 状態を返す。
- `agentic_search` の自然文回答には混ぜない。
- テストで `vectorHitCount` / `fullTextHitCount` / `recentFallbackUsed` を固定する。

### Step 5: review_task 連携は後段で判断する

この計画では `review_task` の全面改修はしない。

ただし、検索側の telemetry が安定した後に、以下だけを追加検討する。

- `selectedKnowledgeIds`
- `knowledge_retrieval_status`
- 実際に prompt に入れた knowledge id との一致検証

## 受け入れ基準

- `search_knowledge` が実データから候補を返す。
- query embedding が vector search に参加する。
- exact / full-text が、ファイル名・エラー名・ツール名を拾える。
- vector が0件でも full-text または recent fallback の状態が分かる。
- `record_task_note` で保存した知識が、同種タスクの `search_knowledge` に出る。
- `agentic_search` のユーザー向け回答は自然文のまま維持される。
- `bun run verify:fast` が通る。

## 検証コマンド

```bash
bun test test/entityKnowledge.test.ts test/mcp/tools/agentFirst.test.ts test/services/knowledge.test.ts
bun run typecheck
bun run lint
bun run verify:fast
```

MCP transport が安定している場合は、最後に実 MCP で `search_knowledge` を確認する。
