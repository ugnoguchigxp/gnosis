# QA / 信頼性改善計画

## 目的

このドキュメントは、Gnosis の「信頼感」を上げるための品質改善計画を定義する。

ここでいう信頼感は、単にユニットテスト数が多いことではない。次の 5 点が揃って初めて成立する。

1. 失敗系が再現可能で、安定して検証できること
2. `bun run verify` の結果が現実の品質状態を正しく表すこと
3. ドキュメントが現行実装と一致していること
4. 統合時の順序依存や環境依存が早期に見つかること
5. 本番運用で異常を観測し、原因を辿れること

つまり、「失敗系の品質保証がまだ弱い」という評価は、主にユニットテストの不足だけを指しているわけではない。ユニットテスト、統合テスト、テストハーネス、CLI 品質ゲート、運用観測の全体設計の問題である。

## 現状認識

現時点で見えている主な課題は次の通り。

1. KnowFlow worker の timeout 系で不安定さがある
2. `verify` と補助スクリプトの一部が現行 Bun の仕様とズレている
3. ドキュメントと実装の差分が残っている
4. フルスイート時にのみ露見する順序依存や共有状態リークの検出が弱い
5. スキップされる統合テスト群の扱いが「任意」寄りで、継続的な信頼性指標になっていない

代表例:

- `src/services/knowflow/worker/loop.ts`
- `test/knowflow/worker/loop.test.ts`
- `scripts/verify.ts`
- `package.json`
- `docs/mcp-tools.md`
- `docs/data-layers.md`

## 改善方針

改善は次の 4 層で進める。

### 1. Failure-first QA

成功系より先に、失敗系の期待挙動を固定する。

対象:

- timeout
- abort
- partial failure
- retry
- backoff
- lock 競合
- empty response
- malformed JSON
- network unreachable
- subprocess non-zero exit
- DB unavailable
- degraded mode fallback

### 2. Deterministic Test Harness

「たまに落ちる」を放置しない。時間、乱数、プロセス、ネットワーク、ファイルシステム競合を制御可能にする。

### 3. Truthful Verification

`verify` が green なら、本当にマージしてよい状態であるべき。逆に実態が壊れているのに green になる状態をなくす。

### 4. Documentation as QA Surface

README と docs も品質面の一部として扱う。実装とズレた説明は、テストがないのと同じくらい信頼を下げる。

## 目標状態

以下を 1 つの基準とする。

1. `bun run verify` がローカル開発者にとって一貫した意味を持つ
2. 失敗系の主要フローに対して、成功系と同程度に回帰テストがある
3. フルスイートを複数回回しても主要テストが安定する
4. スキップ対象の統合テストが、いつローカルで走らせるべきか明文化されている
5. README / tool docs / architecture docs が現行実装と一致する
6. ワーカーや review 系の異常がログ・メトリクスで追える

## 成功指標

### リリース判定指標

- `bun run verify` が連続 5 回成功する
- `bun run verify:strict` が 1 回成功する
- フルスイートで flaky test 0 件
- `bun test --coverage` が安定して完走する
- `test:coverage:summary` のような補助コマンドも実行可能である

### カバレッジ指標

- 全体 line coverage: 80% 以上
- 重要モジュール line coverage: 85% 以上
- 重要モジュール function coverage: 80% 以上

重要モジュール:

- `src/services/knowflow/worker/*`
- `src/services/knowflow/queue/*`
- `src/services/background/*`
- `src/services/review/orchestrator.ts`
- `src/services/review/knowledge/*`
- `src/services/memoryLoopLlmRouter.ts`
- `src/mcp/server.ts`

### 運用指標

- worker timeout 件数
- worker retry/defer/fail 件数
- degraded mode 発生率
- review 実行失敗率
- queue stale task 発生率

## ローカル品質運用モデル

このプロジェクトはローカル導入前提なので、品質も「手元で壊れにくいこと」を中心に設計する。

そのため、品質コマンドは次の 4 層に分ける。

### 1. Fast Feedback

日常の変更中に数分未満で回す。

想定内容:

- lint
- typecheck
- 変更範囲の unit test
- failure-path 集中テスト

### 2. Standard Verify

通常のコミット前に回す基準コマンド。

想定内容:

- `bun run verify`
- coverage 付きテスト
- smoke

### 3. Strict Local Verify

壊れやすい変更、release 前、広範囲リファクタ時に回す。

想定内容:

- フルスイート複数回実行
- `--rerun-each`
- failure-path のストレス実行
- ローカル DB / queue / worker を含む統合検証
- monitor での観測確認

### 4. Soak / Observation

テストだけでは見えない異常を、ローカル常駐実行で炙り出す。

想定内容:

- worker を一定時間流し続ける
- monitor で defer / fail / timeout を確認する
- stale task cleanup や degraded mode の発生有無を見る

## ローカル品質コマンドの再設計

品質を上げるには、開発者が回しやすい粒度のコマンドが必要である。単に `bun run verify` だけに依存すると、重くて回らなくなるか、逆に情報が粗くなる。

追加または整理したいコマンド群:

1. `bun run verify:fast`
2. `bun run verify`
3. `bun run verify:strict`
4. `bun run test:failure-path`
5. `bun run test:flaky-check`
6. `bun run test:integration:local`
7. `bun run observe:worker`
8. `bun run observe:review`

想定する責務:

- `verify:fast`: 開発中の最短フィードバック
- `verify`: 通常のコミット前基準
- `verify:strict`: 連続実行、統合、観測まで含む厳格モード
- `test:failure-path`: timeout, retry, malformed output, DB failure など異常系集中
- `test:flaky-check`: `--rerun-each` や複数回実行で順序依存検出
- `test:integration:local`: ローカル DB / queue / worker の統合経路のみ
- `observe:*`: monitor やログ確認込みの人間向け確認

## ローカルで厚くするべき品質手法

### 1. 再現性を上げる

ローカル品質で最も重要なのは「一度起きた異常をもう一度起こせること」。

施策:

- temp file / sqlite path / queue file path を毎回ユニーク化する
- clock, timer, random, env を依存注入する
- network, subprocess, DB 境界をアダプタ化する
- テスト失敗時に再実行コマンドを標準出力へ出す

### 2. 実時間依存を減らす

ローカルの flaky はほぼ実時間依存で起きる。

施策:

- `setTimeout` / `sleep` の注入
- fake clock helper の整備
- timeout テストから 100ms 待ちのような実時間依存を排除
- retry/backoff は時刻注入で検証する

### 3. ローカル統合経路を最小化して守る

「全部入り」の統合テストではなく、壊れやすい最短経路を固定する。

守るべき最小経路:

- MCP tool call -> service -> DB
- queue enqueue -> worker lock -> handler -> failure action
- review request -> orchestrator -> findings -> persistence
- memory store -> search -> synthesis/consolidation

### 4. 観測込みの品質確認を入れる

ローカル常駐型のシステムは、テスト pass だけでは十分ではない。

施策:

- worker を 10-30 分流す観測手順を用意する
- monitor で見るべき項目を固定する
- worker log の要点を自動で要約する補助スクリプトを作る
- timeout / defer / stale cleanup の件数を確認する

### 5. docs をローカル品質の一部として扱う

ローカル導入型ソフトでは、ドキュメントがインストール手順そのものになる。実装とズレた docs はそのまま品質問題である。

施策:

- verify コマンド一覧を docs と package.json で同期する
- ツール数、主要機能、前提条件を README と実装で揃える
- 「どのコマンドをどのタイミングで回すか」を docs に残す

## 実施計画

## Phase 0: 品質ゲートの整合回復

期間の目安: 最優先、最初の 1-2 日

目的:

- まず「今どこが壊れているのか」を正しく見えるようにする

タスク:

1. `package.json` の coverage 補助コマンドを現行 Bun 仕様に合わせる
2. `scripts/verify.ts` の期待値と Bun 出力形式の依存を見直す
3. `README.md` の verify 説明を現実に合わせる
4. `docs/mcp-tools.md` のツール数と実装一覧を一致させる
5. `docs/data-layers.md` の実装乖離を整理する

完了条件:

- 主要品質コマンドがすべて実行可能
- ドキュメントの明白な数値ズレが解消される

## Phase 1: 失敗系テストの安定化

期間の目安: 2-4 日

目的:

- flaky な failure-path テストを deterministic にする

タスク:

1. `src/services/knowflow/worker/loop.ts` の timeout 設計を見直す
2. `test/knowflow/worker/loop.test.ts` から実時間依存を減らす
3. timeout / abort / retry の検証を fake clock または injectable timer で書き換える
4. handler 側が abort を無視した場合の挙動を明文化し、テスト化する
5. `Promise.race` ベースの timeout 実装で後続非同期が暴れないよう後始末を固定する

具体策:

- `setTimeout` を注入可能にする
- `sleep` / clock / now を依存注入する
- ネットワークや subprocess を直接触らず、アダプタ境界で mock 可能にする

完了条件:

- worker timeout テストが単発・フルスイート両方で安定する
- failure path テストが複数回 rerun でも落ちない

## Phase 2: 順序依存と共有状態リークの排除

期間の目安: 2-3 日

目的:

- 単体では通るがフルスイートで落ちる状態を減らす

タスク:

1. config mock と `process.env` 改変を行うテストを棚卸しする
2. `afterEach` / `beforeEach` で環境を完全に復元する共通ヘルパーを用意する
3. グローバル fetch, timer, logger, cwd 変更などの共有状態を明示管理する
4. test seed / temp dir / sqlite path の命名を衝突しない形に揃える
5. `--rerun-each` 前提の flaky 検査コマンドを追加する

追加する仕組み:

- `bun test --rerun-each 5`
- failure-path 集中スイート
- 環境差分を検知する test helper

完了条件:

- フルスイートでのみ発生する失敗の再現手順がなくなる
- test helper により共通の cleanup 規約ができる

## Phase 3: 統合テストの再定義

期間の目安: 3-5 日

目的:

- スキップされがちな統合テストを「補助」から「ローカルで計画的に回す gate」に変える

タスク:

1. DB 依存テストを `unit`, `integration`, `live` に分類し直す
2. 各テスト群の実行条件を README と docs に明記する
3. queue / worker / DB / MCP の最小統合経路を smoke として固定する
4. live test は常時必須にせず、明示的なローカル opt-in 手順へ分離する
5. skipped test の件数と理由を可視化する

推奨分類:

- Unit: 常時実行
- Integration: ローカル verify:strict で実行
- Live: 明示 opt-in

完了条件:

- 「なぜ skip されているか」「いつローカルで回すか」が各群で説明可能
- 統合テストの責務が unit test と重複しない

## Phase 4: Review / Knowledge 系の重点補強

期間の目安: 4-6 日

目的:

- プロダクト差別化の中心に近い領域を重点的に守る

タスク:

1. `src/services/review/orchestrator.ts` の主要分岐をシナリオテスト化する
2. degraded mode, no findings, changes requested, needs confirmation を全て固定する
3. review 結果の persistence 失敗時の挙動をテストする
4. knowledge retriever / persister の異常系を追加する
5. `src/mcp/server.ts` の always context 注入とエラー応答の contract test を厚くする

完了条件:

- review 系が「動く」だけでなく、「壊れた時にどう壊れるか」が説明できる

## Phase 5: 運用観測の補強

期間の目安: 2-3 日

目的:

- ローカル常駐運用で起きる異常を後から追えるようにする

タスク:

1. worker timeout, defer, fail, circuit breaker の件数を monitor に出す
2. review degraded mode の発生率を定期集計できるようにする
3. stale task cleanup の発火回数を見える化する
4. 「最後の成功時刻」「連続失敗回数」を monitor 上で追いやすくする
5. 重大イベントに共通フィールドを揃える

共通フィールド案:

- `taskId`
- `workerId`
- `topic`
- `source`
- `attempts`
- `durationMs`
- `errorClass`
- `degradedReason`

完了条件:

- テストで捕まらない劣化を monitor / log で早期発見できる

## ローカル手順の標準化

この計画では、開発者のローカル運用手順も品質の一部とみなす。

標準手順案:

1. 小変更時:
   `verify:fast` を回す
2. 通常コミット前:
   `verify` を回す
3. queue / worker / review / memoryLoop に触った時:
   `test:failure-path` と `test:flaky-check` を回す
4. background / DB / monitor に触った時:
   `test:integration:local` を回す
5. release 相当の確認時:
   `verify:strict` と `observe:worker` を回す

人間が確認すべき観点:

- 連続失敗が増え続けていないか
- deferred が詰まり続けていないか
- degraded mode が急増していないか
- stale task cleanup が頻発していないか
- docs の手順で実際に起動・確認できるか

## 優先順位

優先順位は次の通り。

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 4
5. Phase 3
6. Phase 5

理由:

- 今の最大問題は「品質状態が正しく見えないこと」と「failure-path が不安定なこと」
- 次に重いのは「フルスイート時のみ壊れる」こと
- Review / Knowledge は価値の核なので、そこを重点的に守る
- 統合テストの再編は重要だが、先に基礎の deterministic 性を作る必要がある
- 観測性は最後に見えるが、ローカル運用の確認導線は先に決めておくべき

## 実装ポリシー

この計画を進める際のルールを明記する。

1. flaky test は skip ではなく原因を分離する
2. 実時間待ちを伴うテストは原則として依存注入へ寄せる
3. env 書き換えを伴うテストは必ず restore helper を使う
4. docs 修正は機能修正と同じ変更スコープで扱う
5. 成功系だけで merge しない。失敗系の期待挙動を必ず追加する
6. ローカルで回しにくい検証は、分割して専用コマンド化する
7. 観測でしか見えない問題は、monitor とログ確認手順まで含めて定義する

## 最初の実行バックログ

最初に着手するなら、この順で進める。

1. `package.json` の `test:coverage:summary` 修正
2. `scripts/verify.ts` の coverage 取り扱い修正
3. `test/knowflow/worker/loop.test.ts` の timeout テスト安定化
4. `src/services/knowflow/worker/loop.ts` の timer/abort 注入化
5. `docs/mcp-tools.md` のツール一覧更新
6. `docs/data-layers.md` の実装整合
7. env / global state cleanup helper 追加
8. flaky 検査用コマンド追加
9. `verify:fast` / `verify:strict` / `test:failure-path` のスクリプト化
10. worker 観測手順の docs 化

## この計画の完了定義

この改善計画は、次の状態になった時に完了とみなす。

1. ローカル開発者が `bun run verify` を信じてよい
2. failure-path が仕様として読める
3. ドキュメントを読んだ人が実装の現状を誤解しない
4. 主要なバックグラウンド異常が monitor とログで追える
5. 「たまたま通った」ではなく「壊れにくい」と説明できる
