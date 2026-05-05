# Knowledge Retrieval 改善計画

## 目的

この計画は、`search_knowledge` / `agentic_search` / `review_task` が過去知識を実用的に取得し、採用理由を検証できる状態に戻すための全体計画である。

`embedding daemon + 専用queue` は土台として別計画に分離する。この文書では検索品質、知識登録、review連携、利用ログを扱う。

## 対象外

- embedding daemon の常駐化
- embedding 実行queueの分離
- 背景embedding batchの低優先度化

上記は `docs/embedding-daemon-queue-plan.md` で扱う。

## 現状の問題

1. `search_knowledgeV2` が実検索に接続されておらず、`groups: []` / `flatTopHits: []` を返す状態になっている。
2. embedding済みデータは存在するが、一次導線が安定して使っていない。
3. guidance検索はDB側の similarity threshold で候補を捨てるため、初期コーパスでは空振りしやすい。
4. `record_task_note` の保存結果が、再利用検索に即座につながる導線として弱い。
5. `usedKnowledge` / retrieval telemetry が不足し、どの知識が使われたか検証しづらい。

## 改善方針

### 1. `search_knowledgeV2` を実検索に戻す

- task envelope から検索クエリを作る。
- exact / metadata / full-text / vector の候補を取得する。
- 初期はDB側 threshold で候補を捨てず、topKを広めに取る。
- ユーザー向けには候補の要点を自然文で返し、raw候補確認ではスコアを出す。

### 2. embeddingは situation search に使う

- ツール名、ファイル名、エラー名は exact / full-text で拾う。
- embeddingは「作業状況」「困り方」「成功手順」「失敗原因」の類似性を拾う。
- query embedding はユーザー文そのままではなく、目的・症状・対象・作業種別を短く整えた1本のテキストにする。

### 3. 知識レコードに検索用metadataを持たせる

- `intent`
- `changeTypes`
- `technologies`
- `files`
- `kind`
- `category`
- `triggerPhrases`
- `appliesWhen`

metadataは厳密な絞り込み、semantic textはembedding検索の対象として分ける。

### 4. `review_task` のknowledge injectionを検証可能にする

- `knowledge_retrieval_status`
- `candidateCount`
- `selectedKnowledgeIds`
- `vectorHitCount`
- `lexicalHitCount`
- `recentFallbackUsed`

これらを内部ログに残す。ユーザー向け出力は必要最小限にする。

### 5. 疎なコーパスでは成功/手順/skillを優先する

失敗パターン照合を主軸にしない。初期は `procedure` / `skill` / `rule` / Golden Path を優先し、failure evidence は severity確認に使う。

## 実装順

1. `search_knowledgeV2` を実検索化する。
2. query embedding + exact/full-text候補をmergeする。
3. `record_task_note` からretrievable storageへの接続を強化する。
4. `review_task` のknowledge retrieval telemetryを固定する。
5. `agentic_search` / `review_task` の実行ログで、候補取得から採用までを追跡できるようにする。

## 受け入れ基準

- `search_knowledge` が実データから候補を返す。
- embedding indexが空でない場合、query embedding検索が候補取得に参加する。
- 候補が0件でも exact/full-text/recent fallback のどこで失敗したか分かる。
- `review_task` で使われた知識とログ上の `selectedKnowledgeIds` が一致する。
- 低品質な候補を未選別でpromptに混ぜない。
