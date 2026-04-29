# 新生 KnowFlow ガイド

KnowFlow は、Gnosis に登録済みの知識を起点にして、周辺の知識を少しずつ広げるための調査ループです。

以前の KnowFlow は、調査結果を `knowledge_topics` / `knowledge_claims` 側に保存し、Gnosis の通常導線である `search_knowledge` や `entities` と距離がありました。新生 KnowFlow では、既存の entity を直接書き換えるのではなく、その entity と関係の深い新しい知識を見つけて、グラフに新しい node と edge を増やします。

## 基本思想

KnowFlow は seed entity を改善対象として扱いません。seed entity は探索の出発点です。

たとえば `MCP lifecycle cleanup` という decision がある場合、その decision の本文を上書きして詳しくするのではなく、周辺に次のような知識を新しく作ります。

- `lesson`: stale process と zombie process を区別する
- `procedure`: MCP server shutdown checklist
- `risk`: stdio transport close 漏れによる orphan process
- `rule`: cleanup daemon は primary fix ではなく guardrail として扱う
- `concept`: launchd watchdog

これらの新しい entity は、seed entity と `expands`、`supports`、`depends_on`、`alternative_to` などの relation で接続されます。こうすることで、Gnosis の知識グラフは既存知識を塗り替えるのではなく、周辺へ広がっていきます。

## 検索と fetch の流れ

KnowFlow はまず LLM に検索クエリを作らせます。そのクエリを Brave Search へ投げ、検索結果を最大 10 件取得します。

10 件すべてを fetch するわけではありません。検索結果の title、URL、snippet を LLM に渡し、どのページから読むべきかを優先順に並べます。

fetch は必ず直列です。

1. 優先順位の高いページを 1 つ fetch する
2. そのページが今回の目的に有用か LLM が評価する
3. 有用でなければ次の候補を fetch する
4. 十分有用なページが必要件数に達したら、その時点で fetch を止める
5. タスク全体でユニーク URL を 5 ページ試しても有用なページがなければ、そのタスクでは一旦諦める

これは、WebアクセスとローカルLLMの負荷を抑えるためです。1ページ目で十分な一次情報が取れるなら、それ以上読みに行きません。

通常の topic は、有用なページが1件見つかれば必要件数を満たします。高 priority topic は、別ドメインの有用ページを2件まで探します。これは best practice、rule、procedure のような判断を単一ページに寄せすぎないためです。

## ページ有用性の評価

fetch したページは、すぐに知識として採用されるわけではありません。

KnowFlow はまず、そのページが目的に対して有用かを評価します。評価対象は、今回の topic に対して rule、lesson、procedure、risk、decision、または具体的な技術的 claim を支える情報が含まれているかです。

有用性の評価が低いページは捨てます。薄いページ、検索結果一覧、ナビゲーション中心のページ、宣伝色が強いページ、既に読んだ内容とほぼ同じページは、次の候補へ進む理由になります。

現在の実装では、有用性 score が `0.65` 未満の場合は採用しません。

## 目的外だが有用な語句

KnowFlow は、ページが主目的に対して有用かどうかとは別に、そのページに出てきた語句を見ます。

つまり、ページ全体としては今回の調査には使えない場合でも、そこに次の探索seedになりそうな語句が含まれていれば拾います。

これは「今回の topic とは少し違うが、次に調べる価値があるもの」です。たとえば MCP lifecycle を調べている最中に、`stdio transport close`、`parent PID death detection`、`launchd KeepAlive` のような語句が出てきた場合、それらは次の KnowFlow topic になり得ます。

候補語句は score 付きで抽出されます。現在の実装では総合 score が `0.6` 未満の候補は捨てます。また、語句の爆発を防ぐため、次の評価軸も見ます。

- `novelty`: 元の topic から見て新しい情報を増やすか
- `specificity`: その語句だけで検索できるほど具体的か
- `actionability`: rule、lesson、procedure、risk、decision に発展しそうか
- `communityFit`: 元の seed と同じ文脈に属しそうか

特に `specificity` と `actionability` が低い語句は queue に入れません。一般語、固有名詞だけの語句、一過性のニュース語、本文に偶然出てきただけの語句を抑えるためです。

採用された語句は、まず通常の `concept` entity として登録されます。そのうえで、調査状態を表す `knowflow_topic_state` entity を別に作り、follow-up の KnowFlow task として queue に入ります。

重複は除外します。同じタスク内で同じ語句が複数回出た場合は1件にまとめます。queue の dedupe は seed entity や親 task ではなく、`knowflow_topic_state/<topic>` を基準にします。これにより、同じ語句が別の seed から見つかった場合でも、同一 topic として扱いやすくなります。

すでに `queued` の topic state がある場合は、再度 queue には入れません。`explored` と `exhausted` は永久除外ではなく、後述する cooldown と retryAfter に従います。

この扱いにより、KnowFlow は「目的の情報が取れたか」と「次に調べる価値がある語句を拾えたか」を分けて判断できます。

ここでの queue 登録は、語句を「調査候補」として扱うという意味です。目的外の語句を発見したページ自体が今回の topic に使えなくても、その語句は独立した frontier topic として保存され、後続の KnowFlow が別テーマとして調べます。

## コミュニティの継承

Gnosis には `communityId` を持つ entity があります。KnowFlow が seed entity から派生 topic を見つけた場合、新しく作る `concept` entity は seed entity の `communityId` を引き継ぎます。

これにより、同じ文脈から生まれた知識が同じ community にまとまります。

seed entity に community がない場合は、task payload に `seedCommunityId` があればそれを使います。どちらもない場合は community なしで登録します。

KnowFlow は seed entity の本文や metadata を更新しません。seed entity には触らず、新しい entity と relation を追加します。

## Relation の考え方

派生 topic は seed entity と relation でつながります。

代表的な relation は次の通りです。

- `expands`: seed から自然に広がる周辺知識
- `supports`: seed の判断や主張を支える知識
- `depends_on`: seed を理解・運用するための前提
- `used_for`: seed の適用場面
- `alternative_to`: seed と比較すべき代替案
- `contradicts`: seed と衝突する可能性のある知識
- `related_to`: 明確な種類を決められないが関連が深い知識

LLM が relation を決められない場合、既定では `expands` として扱います。

## 失敗時の扱い

検索、fetch、ページ評価、証拠抽出はそれぞれ失敗し得ます。KnowFlow はできるだけ部分失敗で止まらないようにします。

検索に失敗したクエリはスキップします。fetch に失敗したページもスキップして、次の候補へ進みます。ページ評価が degraded した場合は保守的に有用ではないものとして扱います。

派生 topic の登録や follow-up queue 投入は、親タスクの主目的から見ると副作用です。そのため、派生 topic の保存に失敗しても、親タスクで得られた証拠や知識の処理は成功として扱います。失敗は warn ログに残し、次の運用で切り分けます。

5つのユニークページを試しても主目的に有用なページが必要件数に届かなかった語句は、`exhausted` として扱います。これは「二度と調べない」という意味ではなく、現在の検索条件では深掘りに向かないという印です。

高 priority topic では、1件だけ有用なページが見つかっても、必要な別ドメイン確認に届かなければ `explored` にはしません。この場合は「部分的に有用な証拠はあったが、必要件数に届かなかった」状態として `exhausted` にし、`retryAfter` 後の再探索に回します。

`exhausted` には、実際に使った検索 query の list と、その hash を保存します。検索クエリ生成の改善や検索ソースの追加があった場合に、同じ失敗を繰り返したのか、別条件で試す価値があるのかを判断しやすくするためです。

また、`exhausted` は `retryAfter` を持ちます。frontier seeder は `retryAfter` までは通常の自動選定から外しますが、その時刻を過ぎた後は再候補にできます。

## Frontier seeder

新生 KnowFlow は、手動投入だけでなく、DBにある既存 entity から次に調べるべき語句を選びます。

この入口を frontier seeder と呼びます。frontier seeder は `entities` を見て、探索seedになりそうなものを選び、KnowFlow task として queue に入れます。

選定では、次のような entity が優先されます。

- 参照回数が多い
- 最近参照された
- relation が少なく、周辺知識が薄い
- confidence が低い
- community の中で孤立している

一方で、次のものは通常の選定から外します。判定は seed entity 自体だけでなく、対応する `knowflow_topic_state/<topic>` の metadata も見ます。

- `task_trace` のような作業記録
- すでに `queued` のもの
- `explored` になってから cooldown 中のもの
- 5ページ試しても有用な情報が見つからず `exhausted` になり、まだ `retryAfter` を過ぎていないもの

frontier seeder は、選んだ entity を直接書き換えません。選んだ entity の `id` と `communityId` を task payload に入れ、後続の KnowFlow がそこから新しい concept、rule、lesson、procedure、risk を広げられるようにします。

選定状態は seed entity でも通常 concept でもなく、同名の `knowflow_topic_state` entity に保存します。たとえば `MCP lifecycle cleanup` という decision が選ばれた場合、decision 自体の本文や metadata は更新せず、`knowflow_topic_state/MCP lifecycle cleanup` を作り、そこに `queued`、`explored`、`exhausted`、`cooldownUntil`、`retryAfter` などの状態を持たせます。

queue の重複判定も、この `knowflow_topic_state` entity の ID を source group として使います。seed が異なっても topic が同じなら、同じ調査キューとして扱うためです。

KnowFlow が topic を調査し、必要件数ぶんの有用ページを見つけた場合は `explored` になります。ただし、`explored` は完了ではなく cooldown です。現在の実装では一定期間、同じ topic を再選定しないための印として扱います。

5つのユニークページを試しても有用なページが必要件数に届かなかった場合は `exhausted` になります。`exhausted` も永久除外ではなく、`retryAfter` を過ぎれば再選定できます。

frontier seeder は community ごとの偏りも抑えます。参照回数が多い community だけが増殖しないように、1回の seed-frontier で同じ community から選ぶ件数に上限を設けます。

手動で確認する場合は、dry-run で候補だけを見られます。

```bash
bun src/services/knowflow/cli.ts seed-frontier --limit 5 --dry-run
```

実際に queue へ投入する場合は `--dry-run` を外します。

```bash
bun src/services/knowflow/cli.ts seed-frontier --limit 5
```

community ごとの上限を変える場合は `--max-per-community` を指定します。

```bash
bun src/services/knowflow/cli.ts seed-frontier --limit 10 --max-per-community 2
```

## 実装上の入口

主な実装は次のファイルにあります。

- `src/services/knowflow/worker/knowFlowHandler.ts`: 検索、直列 fetch、有用性評価、派生 topic 抽出、topic state 更新、follow-up queue 投入
- `src/services/knowflow/frontier/selector.ts`: DB からの frontier topic 自動選定
- `src/services/knowflow/state/topicState.ts`: `queued`、`explored`、`exhausted`、cooldown、retryAfter の共通処理
- `src/services/knowflow/schemas/llm.ts`: LLM task の出力 schema
- `src/services/knowflow/domain/task.ts`: KnowFlow task payload と expansion metadata
- `src/scripts/webTools.ts`: Brave Search / fallback search / fetch

## 自動探索

frontier seeder は、常駐 background worker が有効な環境では定期タスクとして動きます。既存の `entities` から候補を作り、参照回数、グラフの薄さ、confidence、recency に加えて、`rule`、`procedure`、`risk`、`decision`、`lesson`、`constraint` などの再利用価値を重要度として扱います。

候補の shortlist は LLM に渡され、どれを深掘りすべきかを再順位付けします。LLM が失敗または degraded になった場合でも、deterministic な重要度順位にフォールバックして自動投入は止めません。

制御用の主な環境変数は次の通りです。

- `KNOWFLOW_FRONTIER_ENABLED`: frontier 自動投入の有効/無効
- `KNOWFLOW_FRONTIER_LLM_ENABLED`: LLM 再順位付けの有効/無効
- `KNOWFLOW_FRONTIER_MAX_TOPICS`: 1 tick で queue に投入する最大件数
- `KNOWFLOW_FRONTIER_SCAN_LIMIT`: 候補生成時に見る entity 件数
- `KNOWFLOW_FRONTIER_MAX_PER_COMMUNITY`: 同一 community からの最大選定数

また、重要度の高い topic は単一ページだけで終わらせません。通常 topic は有用なページが1件見つかれば止めますが、高 priority topic は別ドメインの有用ページを追加で探します。best practice やルール化に必要な最低限の裏取りを増やすためです。必要件数に届かなかった場合は、部分的に有用な証拠があっても `explored` ではなく `exhausted` として扱い、`retryAfter` 後の再探索に回します。

`exhausted` は永続的な禁止ではありません。検索クエリ生成の改善、検索対象ソースの追加、Brave Search 以外の取得経路の追加によって、後から再探索する価値が出る可能性はあります。その場合は `retryAfter` 経過後に再選定するか、管理UIやメンテナンス処理で状態を戻す運用を用意します。
