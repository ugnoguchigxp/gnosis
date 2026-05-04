# KnowFlow LLM SystemContext Refactor Plan

## 背景

現状の KnowFlow LLM 経路は要件を満たしていない。

- `src/adapters/llm.ts` がタスクごとの文字列解釈を持っている。
- `query_generation` / `search_result_selection` / `page_usefulness_evaluation` / `extract_evidence` / `registration_decision` が同じ「LLM判断」でありながら別々の出力パーサに分岐している。
- Gemma4 に JSON を求める方向と plain text を求める方向が混在していた。
- confidence / score / priority をコード側で補完または固定注入している。
- 失敗・未登録・薄い探索結果を entity として保存し、Knowledge Graph に不要なノイズを作っている。

根本原因は、LLM の判断をコード側の構造へ戻そうとして `llm.ts` が判断・補正・フォールバックの集積点になったこと。今後の方針は、LLM が SystemContext 上で最終的な KnowFlow Research Note を作り、コードはそれを保存するだけに寄せる。

## 原則

- JSON 出力を Gemma4 に要求しない。
- 正規表現、ラベル探索、文字列置換、URL抽出、yes/no 判定、score 補完を KnowFlow の LLM 制御に使わない。
- `llm.ts` は LLM 呼び出しと生テキスト返却だけを担当する。
- confidence / score / priority をコード側で算出しない。
- 構造化が必要な箇所は、LLM 出力をパースせず、保存対象を「完成済みの本文」に変更する。
- 参考 URL は fetch 成功リストからコード側で付与する。LLM に URL の選択、整形、列挙をさせない。
- 失敗、未登録、低品質、未採用の状態を entity として作らない。
- LLM の役割は「新規フレーズ選定」と「Research Note 作文」に限定する。どちらも複雑な構造化出力を要求しない。

## 目標アーキテクチャ

### 削除する概念

- `LlmTaskOutputMap` を KnowFlow 実行フローの中心に置く設計。
- `parseLlmTaskOutputText` のタスク別 switch。
- `TopicTask.evaluation` / `TopicTask.expansion` に残っていた旧 score / frontier metadata。
- `search_result_selection` の LLM 選択。
- `page_usefulness_evaluation` の LLM yes/no 判定。
- `registration_decision` の LLM 出力パース。
- `extract_evidence` の claim/confidence 行パース。
- `emergent_topic_extraction` の score/whyResearch 行パース。
- `degraded` 成功扱い。
- KnowFlow の失敗状態 entity 永続化。

### 新しい経路

1. `Phrase Scout` が、最近の作業ログ、失敗/成功ログ、既存 knowledge の薄い領域、ローカル repo の技術文脈から、新しく調査すべきプログラミング関連フレーズを選ぶ。
2. コードは `Phrase Scout` が返した各行をそのまま探索 topic として queue に入れる。
3. コードが topic から検索候補を作る。
4. コードが検索結果を固定上限まで fetch する。
5. fetch できた本文だけを、探索 topic と一緒に `Research Note Writer` の SystemContext に渡す。
6. LLM は `KnowFlow Research Note` を自然文で返す。
7. コードは Research Note が空でなければ `concept` に保存し、fetch 成功 URL を参考 URL として付与する。
8. Research Note が空、または LLM 呼び出し失敗なら entity は作らず、task の状態だけに失敗を残す。

この経路では、LLM 出力から URL、boolean、score、claim 配列を抽出しない。`Phrase Scout` はプログラミング関連フレーズを1行1件で返すだけにする。`Research Note Writer` は本文の評価と作文だけに集中する。DB の `entities.confidence` は KnowFlow 由来レコードでは使わないか、nullable 化して未設定にする。

## 実装計画

### Phase 1: LLM adapter の責務縮小

対象:
- `src/adapters/llm.ts`
- `src/services/knowflow/schemas/llm.ts`
- `test/knowflow/llmAdapter.test.ts`

作業:
- `parseLlmTaskOutputText` を削除する。
- `runLlmTask` を `runLlmTextTask` へ置き換えるか、戻り値を `{ task, text, backend, warnings }` に単純化する。
- `unwrapModelEnvelope` は localLlm CLI の wrapper 応答から `response` を取り出すだけにする。ここでは JSON を LLM に要求しない。wrapper の機械応答を読むための処理として限定する。
- `getTaskOutputHint` と `LlmTaskOutputMap` を KnowFlow 実行パスから外す。
- adapter テストは「生テキストが返る」「空なら失敗」「API失敗時にCLIへ移る」だけにする。

完了条件:
- `src/adapters/llm.ts` にタスク別 parser switch が存在しない。
- `llm.ts` に score / confidence / URL / yes/no の判定が存在しない。

### Phase 2: LLM 役割を Phrase Scout と Research Note Writer に整理

対象:
- `src/services/knowflow/worker/knowFlowHandler.ts`
- `src/services/knowflow/cron/keywordSeeder.ts`
- `src/services/knowflow/ops/evidenceExtractor.ts`
- `src/services/knowflow/prompts/*`

作業:
- `keyword_seed_evaluation` と既存のスコアリング/カテゴリ付けを廃止する。
- 新規プロンプト `phrase_scout.md` を追加する。
- `Phrase Scout` は、入力された作業ログや既存 knowledge の短い文脈から、プログラミング関連の調査フレーズだけを1行1件で返す。
- `Phrase Scout` には score / category / whyResearch / confidence を要求しない。
- コード側は返った非空行を queue topic として扱うだけにする。意味判定、キーワード判定、プログラミング関連性の再判定はしない。
- 既存 concept から frontier を広げる経路を主導線にしない。既存 concept は「すでに調査済みまたは薄い領域の参考文脈」としてのみ使う。
- `query_generation` は廃止し、検索クエリは `task.topic` から作る。LLMに検索語リストを作らせない。
- `search_result_selection` は廃止し、検索 provider の順位と固定 fetch budget を使う。
- `page_usefulness_evaluation` は廃止し、fetch できた本文を Research Note Writer にまとめて渡す。
- `extract_evidence` と `registration_decision` は廃止し、`research_note.md` に統合する。
- `emergent_topic_extraction` は一旦無効化する。必要なら後続で Research Note 内の「follow-up topics」を UI 表示用テキストとして保存するが、queue 自動投入には使わない。
- 参考 URL は `fetch` 成功結果の URL 配列をそのまま保存に使う。LLM prompt には入れない。

新規プロンプト:
- `src/services/knowflow/prompts/phrase_scout.md`
- `src/services/knowflow/prompts/research_note.md`

Phrase Scout の SystemContext に含める内容:
- 最近の作業ログや経験ログの短い抜粋
- 既存 knowledge の薄い領域を示す短い文脈
- 「プログラミング、ソフトウェア開発、ローカルLLM、開発ツール、テスト、運用、自動化、コードレビューに関係する語句だけを返す」という方針

Phrase Scout の SystemContext に含めない内容:
- 既存 concept の大量リスト
- score / confidence / category の要求
- 正規表現やキーワードルールの説明
- URL

Research Note Writer の SystemContext に含める内容:
- topic
- seed entity の display name / description
- fetched pages の本文 excerpt
- 既存 knowledge の短い要約
- 保存対象は「実際に調査で分かった再利用可能な知識だけ」
- confidence や出典列挙は要求しない
- 調査結果が薄い場合は空文字または短い `NO_REUSABLE_KNOWLEDGE` を返す

SystemContext に含めない内容:
- URL
- title
- domain
- source ranking
- fetch metadata
- confidence / score / priority の数値要求

完了条件:
- KnowFlow の LLM task が `Phrase Scout` と `Research Note Writer` の2つだけになる。
- `registration_decision_unavailable` のような fallback decision がなくなる。

### Phase 3: 永続化モデルの整理

対象:
- `src/services/knowflow/knowledge/repository.ts`
- `src/services/knowflow/worker/knowFlowHandler.ts`
- `src/db/schema.ts`
- migration
- `src/services/knowflow/domain/task.ts`

作業:
- `concept` entity には Research Note 本文と、コード側で付与した参考 URL を保存する。
- 参考 URL は fetch 成功リストを `metadata.referenceUrls` に保存する。UI/表示用に本文へ出す場合も、LLM出力ではなく保存時にコードで末尾へ添付する。
- `knowflow_topic_state` entity は作らない。状態は `topic_tasks` または専用 run log に残す。
- `entities.confidence` は KnowFlow 由来 entity では未設定にできるよう nullable/default の扱いを見直す。
- `knowledge_claims` へ claim 単位で分解する処理は廃止または後続タスクへ分離する。
- 失敗、deferred、no useful knowledge、not recorded は entity にしない。
- `TopicTask.evaluation` と旧 frontier `expansion` metadata は、新設計では書き手が存在しないため削除する。

完了条件:
- `KF_PIPELINE_FAILED` / `KF_NO_KNOWLEDGE` / `KnowFlow attempted...` / `KnowFlow follow-up topic discovered...` の entity が新規作成されない。
- `DisplayName = Full Description` の entity が新規作成されない。

### Phase 4: Queue と新規フレーズ選定を再設計

対象:
- `src/services/knowflow/cron/keywordSeeder.ts`
- `src/services/knowflow/worker/knowFlowHandler.ts`

作業:
- 新規フレーズ選出は `Phrase Scout` に集約する。
- `Phrase Scout` の入力は既存 concept 起点に限定しない。最近の作業ログ、失敗/成功ログ、セッション要約、ローカル repo の技術スタックを seed とする。
- `Phrase Scout` が返したフレーズは、プログラミング関連と判断済みの探索 topic として扱う。
- Research Note が保存できた topic は、次回 Phrase Scout の文脈に短く入れる。
- LLM 出力をパースして queue を増やす処理は止める。
- follow-up topic は Research Note 本文に含めるだけにし、自動 queue 投入は別計画に分離する。

完了条件:
- queue 増殖が Research Note の成功保存と分離される。
- 未検証 phrase だけで concept が増えない。
- 既存 concept だけを起点にした閉じた frontier ではなく、作業ログ由来の新規プログラミング語句が queue に入る。

### Phase 5: Cleanup

対象データ:
- `DisplayName = Full Description`
- `description = Extracted from plain-text emergent topic output.`
- `description LIKE 'KnowFlow follow-up topic discovered from%'`
- `description LIKE 'KnowFlow attempted this frontier topic but did not record enough useful knowledge.%'`
- `description LIKE 'KF_PIPELINE_FAILED%'`
- `description LIKE 'KF_NO_KNOWLEDGE%'`
- `description LIKE '[System] Tool call or think block was generated but failed to parse.%'`

作業:
- 既存 cleanup script を一つに統合する。
- `dry-run` / `--apply` のみを提供する。
- cleanup 対象のプレフィックスは設定値ではなく、この移行専用の固定リストに閉じ込める。

完了条件:
- cleanup 実行後、上記 entity が 0 件。
- script は移行後に削除できる構造にする。

### Phase 6: 検証

必須コマンド:
- `bun test test/knowflow/llmAdapter.test.ts`
- `bun test src/services/knowflow/worker/knowFlowHandler.test.ts`
- `bun run typecheck`
- `bun run src/services/knowflow/cli.ts run-once --strict-complete --verbose --json`
- `bun run src/services/knowflow/cli.ts seed-phrases --limit 5 --json`
- `bun run src/services/knowflow/cli.ts eval-run --suite local --mock --json`

DB 検証:
- `Phrase Scout` 由来 queue topic がプログラミング関連の語句になっている。
- 既存 concept 名の再投入だけで queue が埋まらない。
- Research Note が保存された concept の `description` に実際の調査内容が含まれる。
- Research Note が保存された concept の `metadata.referenceUrls` に fetch 成功 URL が含まれる。
- 失敗 task で entity が増えない。
- `entities.confidence` が KnowFlow 由来で固定値注入されない。
- cleanup 対象 entity が新規作成されない。

## 実装時の改善差分

以下は計画の目的と矛盾しない純粋な改善として、実装時に計画へ取り込む。

- 旧 frontier / evaluation / verifier / merge / gap / report / pipeline 系のファイルとテストは、互換レイヤーとして残さず削除する。
- `knowflow_keyword_evaluations` は schema から削除し、forward drop migration で扱う。Monitor inventory / eval UI からも旧 evaluation surface を削除する。
- `TopicTask.evaluation` と旧 frontier `expansion` schema は、score / whyResearch / frontier metadata の再流入点になるため削除する。
- `llm-task` CLI は `phrase_scout` / `research_note` 以外を拒否する。adapter 自体は汎用の plain-text runner だが、KnowFlow CLI の入口は2役割に閉じる。
- `eval-run` は degraded 成功率を持たない。plain-text LLM task が成功したか失敗したかだけを `passRate` / `passed` / `failed` で見る。
- Phrase Scout は daemon と background manager の常時ループに接続する。queue consumer が動くだけで seed が入らない状態を成功扱いにしない。
- Research Note Writer には daemon / background manager / CLI の全経路で既存 knowledge の短い要約を渡す。
- orphan running task recovery は JSON payload だけでなく `topic_tasks.next_run_at` column も更新し、復旧後に dequeue 可能な状態へ戻す。
- cleanup script は `dry-run` / `--apply` だけを受け付ける。移行対象以外の option は追加しない。

## ロールバック

- Phase 1 と Phase 2 は同一 PR で行う。片方だけだと実行経路が壊れる。
- Phase 3 の DB migration は、既存データ削除とは別にする。
- cleanup は必ず `dry-run` の件数確認後に `--apply`。
- runtime 検証で Research Note が保存されない場合、LLM出力を補正せず SystemContext を短くする。

## 受け入れ基準

- KnowFlow LLM 経路が `Phrase Scout` と `Research Note Writer` の2役割だけになる。
- `llm.ts` に KnowFlow タスク別の文字列解釈がない。
- Gemma4 に JSON を要求しない。
- confidence / score / priority をコード側で作らない。
- 新規調査 topic は LLM がプログラミング関連性を判断して選ぶ。
- 既存 concept だけを起点にした探索に戻らない。
- 調査結果が `concept.description` に直接反映される。
- 失敗・未登録・低品質探索結果が entity として作成されない。
- 実行ログで、検索、fetch、Research Note生成、保存の各段階が確認できる。
