# Active-Use Improvement Implementation Plan

最終更新: 2026-04-29

## 目的

Gnosis の主要機能を「実装されている」状態から「エージェントと運用ループが能動的に使える」状態へ引き上げる。

この計画は、すぐ実装に着手できる粒度を基準にする。各 Phase は PR 単位で切れるように、対象ファイル、実装手順、データ契約、テスト、受け入れ条件を固定する。

## 前提と非目標

> 現在の MCP 公開面は `docs/agentic-search-memory-loop-plan.md` の方針を優先する。この文書内の `activate_project` / `start_task` / `finish_task` 維持前提は旧方針として扱う。

- Agent-First MCP の primary tool surface は増やさない。公開面は `initial_instructions` / `agentic_search` / `search_knowledge` / `record_task_note` / `review_task` / `doctor` を維持する。
- KnowFlow / Hook / Failure Firewall は primary MCP tool ではなく、既存 tool、background manager、Monitor、CLI へ接続する。
- dry-run は副作用なし、短時間、LLM 非依存を既定にする。LLM を使う場合は明示フラグに寄せる。
- `.env` はこの計画では編集しない。自動化に必要な環境変数は LaunchAgent plist、docs、または設定読み取り側で扱う。
- 認証バイパス、独自サーバー起動、Git 操作はこの計画の範囲外とする。

## 現状インベントリ

現 checkout で確認した実装入口は以下。

| 領域 | 実装入口 | 現状メモ |
| :--- | :--- | :--- |
| Agent-First MCP | `src/services/agentFirst.ts`, `src/mcp/tools/agentFirst.ts` | task trace、knowledge lookup、review が集約されている。Hook event もここから発火できる。 |
| Automation / LaunchAgent | `scripts/setup-automation.sh`, `scripts/automation/*.plist`, `src/services/background/manager.ts` | worker / sync / guidance / reflect / report / process-watchdog の LaunchAgent が対象。二段 gate は `GNOSIS_ENABLE_AUTOMATION` と `GNOSIS_BACKGROUND_WORKER_ENABLED`。 |
| KnowFlow | `src/services/knowflow/cli.ts`, `src/services/knowflow/cron/keywordSeeder.ts`, `src/scripts/worker.ts`, `src/services/background/manager.ts` | `seed-phrases` / Phrase Scout に新規フレーズ選定を集約し、worker が queue 消費も seed 投入も担う。 |
| Run log / Monitor | `src/services/knowflow/ops/runLog.ts`, `src/scripts/monitor-snapshot.ts`, `apps/monitor/src/routes/+page.svelte`, `apps/monitor/src-tauri/src/monitor/models.rs` | CLI / background task の JSONL から snapshot を作る構造。 |
| Doctor | `scripts/doctor.ts`, `src/services/agentFirst.ts` | CLI doctor と MCP doctor が別経路。automation / LaunchAgent / last KnowFlow run は CLI doctor 側に寄っている。 |

| Review / Failure Firewall | `src/services/failureFirewall/*`, `src/services/review/orchestrator.ts`, `src/scripts/failure-firewall.ts` | `review_task` の goal と CLI の両方から使える形に寄せる。 |

## 完了条件

以下をすべて満たす。

- `bun run doctor` が automation gate、background worker gate、LaunchAgent、hooks、last KnowFlow run、local LLM の状態を、実行可能性の観点で説明できる。
- `scripts/setup-automation.sh install && scripts/setup-automation.sh load` 後、worker だけでなく sync / guidance / reflect / report / process-watchdog が意図した env を持って登録される。
- `bun run monitor:snapshot` または Monitor UI で、KnowFlow queue、seed loop、worker、last success/failure、automation gate、local LLM 設定を確認できる。
- `bun src/services/knowflow/cli.ts seed-phrases --limit 3 --json` が Phrase Scout 由来 topic を queue に投入する。

- `bun run failure-firewall -- --help` が review を実行せず usage だけを返す。
- `bun run verify:fast` が通る。

## Phase 0: 着手前ベースライン固定

目的: 実装前に「本当に壊れている箇所」と「すでに実装済みの箇所」を分ける。

対象ファイル:

- `docs/active-use-improvement-plan.md`
- `package.json`
- `scripts/setup-automation.sh`
- `scripts/doctor.ts`
- `src/scripts/monitor-snapshot.ts`
- `src/services/knowflow/cli.ts`
- `src/services/knowflow/cron/keywordSeeder.ts`
- `src/services/background/manager.ts`
- `src/services/background/runner.ts`
- `src/services/agentFirst.ts`
- `src/mcp/tools/agentFirst.ts`
- `src/services/failureFirewall/cli.ts`

実装手順:

1. `git status --short` で既存の未コミット変更を把握する。既存変更は巻き戻さない。
2. 計画対象のコマンドが package script に存在するか確認する。
3. 現状の `doctor` / `monitor:snapshot` / `seed-phrases` / `failure-firewall --help` を一度実行し、失敗箇所を Phase ごとの issue としてメモする。
4. docs と実装の差分を `rg` で確認し、古い tool 名や古い workflow 名を洗い出す。

ベースラインコマンド:

```bash
git status --short
bun run doctor
bun run monitor:snapshot
bun src/services/knowflow/cli.ts seed-phrases --limit 3 --json
bun run failure-firewall -- --help
rg -n "task_checkpoint|record_experience|ナラティブ記憶|docs/architecture.md" README.md docs src
```

受け入れ条件:

- 失敗がある場合、どの Phase の対象か分類できている。
- 既存の未コミット変更を破壊していない。
- 「実装済み」「要修正」「docs だけ古い」が区別できている。

## Phase 1: Automation Gate と LaunchAgent の整合

目的: `setup-automation.sh` で install/load した job が、意図した環境変数を持って実行される状態にする。

対象ファイル:

- `scripts/setup-automation.sh`
- `scripts/automation/com.gnosis.worker.plist`
- `scripts/automation/com.gnosis.sync.plist`
- `scripts/automation/com.gnosis.guidance.plist`
- `scripts/automation/com.gnosis.reflect.plist`
- `scripts/automation/com.gnosis.report.plist`
- `scripts/automation/com.gnosis.process-watchdog.plist`
- `src/services/background/manager.ts`
- `src/scripts/worker.ts`
- `docs/daemon.md`
- `docs/configuration.md`

現状確認ポイント:

- `PLISTS` 配列に 6 job が含まれているか。
- worker plist に `GNOSIS_ENABLE_AUTOMATION=true` と `GNOSIS_BACKGROUND_WORKER_ENABLED=true` があるか。
- scheduled job の plist に `GNOSIS_ENABLE_AUTOMATION=true` があるか。
- `process-watchdog` は automation gate が必要か、常時安全な dry-run/cleanup job として扱うかを明文化する。

実装手順:

1. `setup-automation.sh` の `PLISTS` を単一の正とし、install/load/unload/uninstall/status が同じ配列を使うようにする。
2. `install` で `{{PROJECT_ROOT}}` と `{{BUN_PATH}}` を置換する処理を 6 plist すべてに適用する。
3. `status` は `launchctl print gui/$UID/<label>` を使い、以下を表示する。
   - `not installed`: `~/Library/LaunchAgents/<plist>` が存在しない。
   - `not loaded`: plist はあるが `launchctl print` に存在しない。
   - `loaded`: `state` / `pid` / `last exit code` / `program arguments` が見える。
4. plist の env は次の契約に揃える。
   - worker: `GNOSIS_ENABLE_AUTOMATION=true`, `GNOSIS_BACKGROUND_WORKER_ENABLED=true`
   - sync/guidance/reflect/report: `GNOSIS_ENABLE_AUTOMATION=true`
   - process-watchdog: gate なしで安全に動く設計なら env 不要。gate を見るなら docs に理由を書く。
5. `src/scripts/worker.ts` と `src/services/background/manager.ts` の gate 判定を docs の説明と合わせる。
6. `docs/daemon.md` と `docs/configuration.md` に二段 gate と LaunchAgent の確認手順を追加する。

テスト追加:

- shell script は `bash -n scripts/setup-automation.sh` で構文検証する。
- plist の env は grep ベースの軽量テストで十分。必要なら `test/automationPlist.test.ts` を追加し、XML 文字列に key があることを確認する。

受け入れ条件:

- `scripts/setup-automation.sh install` が 6 plist をコピー対象にする。
- `scripts/setup-automation.sh status` が未インストール、未ロード、ロード済みを区別する。
- worker の env に `GNOSIS_ENABLE_AUTOMATION=true` と `GNOSIS_BACKGROUND_WORKER_ENABLED=true` がある。
- sync/guidance/reflect/report の env に `GNOSIS_ENABLE_AUTOMATION=true` がある。
- docs が `.env` 編集前提ではなく、LaunchAgent と config default の関係を説明している。

検証:

```bash
bash -n scripts/setup-automation.sh
rg -n "GNOSIS_ENABLE_AUTOMATION|GNOSIS_BACKGROUND_WORKER_ENABLED" scripts/automation
scripts/setup-automation.sh status
bun run doctor
git diff --check -- scripts/setup-automation.sh scripts/automation docs/daemon.md docs/configuration.md
```

## Phase 2: KnowFlow Phrase Scout と自動探索の実用化

目的: 新規フレーズ選定を Phrase Scout に集約し、常駐 worker で seed 生成と queue 消費がつながる状態にする。

対象ファイル:

- `src/services/knowflow/cli.ts`
- `src/services/knowflow/cron/keywordSeeder.ts`
- `src/services/knowflow/cron/phraseScoutLoop.ts`
- `src/scripts/worker.ts`
- `src/services/background/manager.ts`
- `src/services/background/runner.ts`
- `test/knowflow/keywordSeeder.test.ts`
- `test/runner.test.ts`

実装手順:

1. 旧 frontier seed CLI / background task / selector を削除し、既存 concept 起点の閉じた seed 経路をなくす。
2. 常駐 worker が起動時と `KNOWFLOW_PHRASE_SCOUT_INTERVAL_MS` 間隔で `runKeywordSeederOnce` を呼び、Phrase Scout の出力だけを queue topic にする。
3. `src/services/background/manager.ts` も同じ Phrase Scout loop helper を使い、入口を増やさず同じ seed 実装を呼ぶ。
4. daemon 経路の Research Note Writer にも `getExistingKnowledge` を渡し、保存済み topic の短い文脈を次回調査に使えるようにする。
5. Monitor snapshot は `knowflow.phrase_scout.completed` と `knowflow_keyword_seed` を seed 成功として扱う。

受け入れ条件:

- 旧 frontier seed の runtime 経路が存在しない。
- background worker 有効時に Phrase Scout の last seed が Monitor snapshot から確認できる。
- worker が空 queue を消費しているだけの状態にならない。
- Phrase Scout 失敗時に entity を作らず、queue 投入も成功扱いにしない。

検証:

```bash
bun src/services/knowflow/cli.ts seed-phrases --limit 3 --json
bun test test/knowflow/keywordSeeder.test.ts test/runner.test.ts test/monitorSnapshot.test.ts
```

## Phase 3: Doctor / Monitor の能動機能 Health

目的: ユーザーが「なぜ能動機能が動いていないか」を CLI と Monitor UI で判断できるようにする。

対象ファイル:

- `scripts/doctor.ts`
- `src/services/agentFirst.ts`
- `src/scripts/monitor-snapshot.ts`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src/routes/+page.svelte`
- `apps/monitor/src-tauri/src/monitor/models.rs`
- `apps/monitor/src-tauri/src/monitor/state.rs`
- `apps/monitor/src-tauri/src/monitor/ws.rs`
- `test/monitorSnapshot.test.ts`

Doctor 追加契約:

- `automation gate`: `GNOSIS_ENABLE_AUTOMATION` の effective value と default を表示する。
- `background worker gate`: `GNOSIS_BACKGROUND_WORKER_ENABLED` の effective value と default を表示する。
- `launch agents`: macOS では 6 label の loaded count と不足 label を表示する。非 macOS では skipped。
- `last KnowFlow run`: run log から worker / seed / failure の最新状態を表示する。
- `local-llm health`: `GNOSIS_DOCTOR_REQUIRE_LOCAL_LLM=true` のときだけ fail 扱いにする。

Monitor snapshot 追加契約:

```ts
type AutomationSnapshot = {
  automationGate: boolean;
  backgroundWorkerGate: boolean;
  localLlmConfigured: boolean;
  localLlmApiBaseUrl: string | null;
  launchAgents?: {
    supported: boolean;
    loaded: number;
    expected: number;
    missingLabels: string[];
  };
};

type KnowFlowSnapshot = {
  status: 'idle' | 'healthy' | 'degraded' | 'unknown';
  lastWorkerTs: number | null;
  lastWorkerSummary: string | null;
  lastSeedTs: number | null;
  lastSeedSummary: string | null;
  lastKeywordSeedTs: number | null;
  lastFailureTs: number | null;
};
```

実装手順:

1. `scripts/doctor.ts` と `src/scripts/monitor-snapshot.ts` で run log parsing の判定を揃える。
2. KnowFlow 以外の background failure で `knowflow.status=degraded` にならないように、`taskType` filter を `knowflow` / `knowflow_*` に限定する。
3. Monitor UI top page に以下を表示する。
   - automation gate
   - worker gate
   - local LLM configured
   - queue pending/running/deferred/failed
   - KnowFlow last worker / last seed / phrase scout / last failure
   - queue が空のときの補助情報: last seed がない、last seed はあるが候補なし、last worker failure あり
4. Tauri Rust model と TypeScript type のフィールド名を揃える。snake_case / camelCase 変換は serde の設定で明示する。
5. `test/monitorSnapshot.test.ts` に run log 判定の regression test を追加する。

受け入れ条件:

- `bun run doctor` が automation disabled の理由を二段 gate で説明する。
- `bun run monitor:snapshot` が queue だけでなく seed/worker/automation health を返す。
- Monitor UI で「worker は起動中だが seed が走っていない」状態を区別できる。
- unrelated background task failure で KnowFlow degraded にならない。

検証:

```bash
bun run doctor
bun run monitor:snapshot
bun test test/monitorSnapshot.test.ts
bun run build
```



## Phase 5: Review / Failure Firewall CLI の誤実行防止

目的: Failure Firewall を `review_task` の一部として安全に使いつつ、CLI の accidental run を防ぐ。

対象ファイル:

- `src/services/failureFirewall/cli.ts`
- `src/scripts/failure-firewall.ts`
- `src/services/failureFirewall/index.ts`
- `src/services/failureFirewall/patternStore.ts`
- `src/services/review/orchestrator.ts`
- `docs/failure-firewall.md`
- `test/failureFirewall.test.ts`

CLI 契約:

```bash
bun run failure-firewall -- --help
bun run failure-firewall -- --json --mode worktree
bun run failure-firewall -- --mode git_diff --knowledge-source hybrid
bun run failure-firewall -- --mode worktree --with-llm
```

- `--help` / `-h` / `help` は usage を返し、diff 読み取りや review を実行しない。
- `--mode` は現状の diff source として維持する。将来 `--diff-mode` に移行する場合は互換 wrapper を残す。
- `--with-llm` は local LLM preflight を行い、失敗時は fast fallback に落として `degradedReasons` に理由を入れる。
- `--knowledge-source` は `entities` / `dedicated` / `hybrid` のみ受け付ける。

Review 契約:

- `review_task` は `goal` に `failure_firewall` が含まれる場合、Review Stage C で local firewall route を使う。
- `failure_firewall --with-llm` は LLM adjudication を追加するが、LLM failure で fast findings を消さない。
- `failure_firewall --knowledge-source dedicated|entities|hybrid` は pattern retrieval の source を切り替える。

実装手順:

1. `src/services/failureFirewall/cli.ts` で help 判定を parse 前に行う。
2. `parseArgs` は unknown option を黙殺しすぎない。最低限、mode と knowledge-source の不正値は usage 付きでエラーにする。
3. local LLM preflight は 1.5 秒程度で timeout し、失敗時は fast fallback として review を続ける。
4. `resolveFailureFirewallGoalOptions` の parser と CLI parser の許容値を揃える。
5. docs は primary MCP tool 追加ではなく、`review_task` の goal 例と CLI 例を中心にする。

テスト追加:

- `bun run failure-firewall -- --help` 相当の unit で `runFailureFirewall` が呼ばれないことを確認する。
- `resolveFailureFirewallGoalOptions` が `--with-llm` と `--knowledge-source` を解釈することを確認する。
- dedicated table failure 時に hybrid が seed/entity へ fallback することを確認する。

受け入れ条件:

- `bun run failure-firewall -- --help` が usage を返し、review output を生成しない。
- `bun run failure-firewall -- --json --mode worktree` が従来どおり JSON review を返す。
- `review_task` から Failure Firewall mode を使うテストが維持される。
- LLM preflight failure は degraded として見えるが、fast findings は保持される。

検証:

```bash
bun run failure-firewall -- --help
bun run failure-firewall -- --json --mode worktree
bun test test/failureFirewall.test.ts
```

## Phase 6: Docs の実態整合と古い主張の整理

目的: docs が現在の Agent-First / entity-centric 方針を正しく説明し、古い ナラティブ記憶 / legacy tool 主張を残さない。

対象ファイル:

- `README.md`
- `docs/project-value-evaluation.md`
- `docs/mcp-tools.md`
- `docs/configuration.md`
- `docs/hooks-guide.md`
- `docs/knowflow-guide.md`
- `docs/failure-firewall.md`
- `docs/daemon.md`
- `docs/startup.md`

実装手順:

1. README の docs link と実在ファイルを照合し、存在しないリンクを修正する。
2. `docs/mcp-tools.md` は Agent-First primary tool surface と一致させる。
3. `docs/knowflow-guide.md` に deterministic dry-run、`--use-llm`、background seed loop、二段 gate を追記する。
4. `docs/hooks-guide.md` は Phase 4 の event 契約に合わせ、存在しない `task_checkpoint` 前提を削除する。
5. `docs/failure-firewall.md` は `review_task` goal と CLI の使い分けを明確化し、primary MCP tool 追加に見える表現を避ける。
6. ナラティブ記憶 / `record_experience` を primary workflow と誤読させる記述は削除するか historical note に移す。

受け入れ条件:

- README から存在しない docs へのリンクが消える。
- ナラティブ記憶 / `record_experience` を primary workflow と誤読させる記述が消える。
- Hook / Failure Firewall / KnowFlow の docs が実装入口とコマンド名に一致する。
- `rg` の残存箇所は historical note または migration context として説明されている。

検証:

```bash
rg -n "task_checkpoint|record_experience|ナラティブ記憶|docs/architecture.md" README.md docs
git diff --check -- README.md docs
```

## PR 分割案

| PR | 内容 | 主な検証 |
| :--- | :--- | :--- |
| PR-0 | ベースライン確認と計画書更新 | `git diff --check -- docs/active-use-improvement-plan.md` |
| PR-1 | LaunchAgent / automation gate 修正 | `bash -n`, plist grep, `doctor` |
| PR-2 | KnowFlow dry-run deterministic 化 | KnowFlow CLI dry-run, KnowFlow unit tests |
| PR-3 | doctor / monitor health 拡張 | `doctor`, `monitor:snapshot`, `test/monitorSnapshot.test.ts`, `build` |

| PR-5 | Failure Firewall CLI help/preflight | Failure Firewall CLI, `test/failureFirewall.test.ts` |
| PR-6 | docs 整合 | terminology grep, `git diff --check` |
| PR-7 | 全体検証と回帰修正 | `bun run verify:fast` |

推奨順は PR-1、PR-2、PR-3、PR-4、PR-5、PR-6、PR-7。Phase 4 は workflow の仕様判断を含むため、Phase 1-3 で health と run log が見える状態にしてから着手する。

## 実装チェックリスト

- [ ] `setup-automation.sh` が 6 plist を同じ配列で扱う。
- [ ] plist env と docs の二段 gate 説明が一致する。
- [ ] `seed-phrases --limit 3 --json` が Phrase Scout 由来の topic を投入する。
- [ ] background manager / worker が同じ Phrase Scout seed helper を使う。
- [ ] run log から Monitor snapshot が seed / worker / failure を区別する。
- [ ] Monitor UI が queue empty の理由を推測できる情報を出す。

- [ ] `failure-firewall --help` が review を実行しない。
- [ ] `review_task` goal から Failure Firewall mode を使える。
- [ ] docs から古い primary workflow 表現が消える。
- [ ] `bun run verify:fast` が通る。

## リスクと対策

| リスク | 影響 | 対策 |
| :--- | :--- | :--- |
| 自動化が LLM/CPU を圧迫する | ローカル環境が不安定になる | defaults は有効のまま、`GNOSIS_ENABLE_AUTOMATION=false` と concurrency gate で停止・制限できるようにする |
| dry-run が LLM や DB mutation に寄る | 確認コマンドが重くなる | dry-run は deterministic 既定、LLM は `--use-llm`、enqueue は実行しない |

| Monitor が状態表示だけ増えて原因が読めない | ユーザーが次アクションに進めない | health panel に対応 config key と確認コマンドを表示する |
| Failure Firewall が汎用 review と重複する | review noise が増える | Golden Path 逸脱と再発検知に責務を限定する |
| docs が実装から乖離する | 誤った運用を誘導する | 各 Phase の acceptance criteria に docs 更新と terminology grep を含める |

## 最終検証

全 Phase 完了後に実行する。

```bash
bun run doctor
bun run monitor:snapshot
bun src/services/knowflow/cli.ts seed-phrases --limit 3 --json
bun run failure-firewall -- --help
bun test test/knowflow/keywordSeeder.test.ts test/runner.test.ts test/monitorSnapshot.test.ts test/failureFirewall.test.ts test/mcp/tools/agentFirst.test.ts
bun run verify:fast
git diff --check -- README.md docs scripts src test
```

Monitor UI では以下を確認する。

- automation gate が enabled / disabled のどちらか明確に表示される。
- background worker gate が enabled / disabled のどちらか明確に表示される。
- KnowFlow seed と worker の last run が確認できる。
- queue が空の場合でも「seed が走っていない」のか「seed は走ったが候補がない」のか区別できる。
- Failure Firewall は primary MCP tool としてではなく、review/CLI の導線として説明されている。
