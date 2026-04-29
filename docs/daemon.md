# MCP/Bun Runtime Lifecycle Plan

最終更新: 2026-04-28

## 結論

軽量デーモンによる監視・掃除は有用だが、主対策にしてはいけない。まず MCP サーバー自身が「親の終了」「stdio の切断」「シグナル」「内部 child process」を正しく扱い、正常終了できるようにする。その上で、取りこぼしを検知して片付ける軽量 watchdog を補助策として導入するのが、このプロジェクトには最も合う。

理由は以下。

- macOS/Unix の厳密な zombie process は `Z` 状態で、通常はメモリをほぼ保持せず、`kill` では消せない。親プロセスが `wait` して回収するか、親が終了して `launchd` などに引き取られる必要がある。
- ユーザーが観測している深刻なメモリ圧は、多くの場合「zombie」ではなく、親 MCP client から切断されたあとも生き続ける orphan/stale Bun process である可能性が高い。
- そのため「zombie を見つけて kill する daemon」では根本解決にならない。対象は `gnosis-mcp-server` / 関連 Bun process の stale/orphan 判定と、プロセスツリー単位の graceful shutdown であるべき。
- 現行の `src/index.ts` は `SIGINT` / `SIGTERM` / `stdin close` の cleanup を持つが、親 PID 監視、transport close の扱い、子プロセスツリー管理、プロセス registry はまだ弱い。

## 現状観察

関連箇所:

| 領域 | ファイル | 現状 |
| :--- | :--- | :--- |
| MCP 本体 | `src/index.ts` | `process.title = 'gnosis-mcp-server'`、`.gnosis.pid`、`stdin close`、`SIGTERM` cleanup がある |
| MCP 補助 server | `src/scripts/mcpToolsServer.ts` | `stdin close` で `process.exit(0)` |
| semantic MCP | `src/scripts/semanticCodeMcpServer.ts` | `stdin close` で `process.exit(0)` |
| LLM spawn | `src/services/llm/spawnControl.ts` | active child PID を Set 管理し、親 `exit` 時に `SIGTERM` を送る |
| worker daemon | `src/scripts/worker.ts` | `SIGINT` / `SIGTERM` cleanup と watchdog がある |
| 既存計画 | `docs/gnosis-supervisor-implementation-plan.md` | 1 ユーザー 1 supervisor 方式の大きめの設計がある |

懸念点:

- `src/index.ts` は `server.connect(transport)` 完了後の正常 close を cleanup に接続していない。コメントアウトされた `await cleanup('Connection closed')` がある。
- `stdin close` だけでは、MCP client 側の異常終了や desktop app のクラッシュを常に検知できるとは限らない。
- `.gnosis.pid` は単一 PID しか保持できず、複数 instance 許容に変更済みの現在は監視 registry として不十分。
- `spawnControl.ts` は子 PID 単体を kill するだけで、孫プロセスを含む process group/tree の停止保証が弱い。
- `process.on('exit')` では async cleanup ができない。終了前に explicit cleanup を走らせる設計が必要。

## 方針

### 1. まず MCP 本体を自己終了できるようにする

MCP server は stdio 接続を所有する client の寿命に従うべきで、外部 daemon に回収される前に自分で終了するのが正しい。

実装方針:

- `src/index.ts` に lifecycle manager を切り出す。
- `stdin` の `close` / `end` / `error` をすべて shutdown trigger にする。
- 起動時の `process.ppid` を保存し、短い interval で親プロセスの生存を確認する。
- 親 PID が `1` に変わった、または `process.kill(originalPpid, 0)` が失敗した場合は stale とみなして graceful shutdown する。
- `SIGTERM` では cleanup 後に `0` 終了、fatal 系では `1` 終了に統一する。
- cleanup は idempotent にし、二重実行しても副作用が出ないようにする。

shutdown state machine:

| State | 意味 | 許可される遷移 |
| :--- | :--- | :--- |
| `starting` | registry 登録前、transport 未接続 | `running`, `stopping` |
| `running` | MCP transport 接続済み、parent watch 稼働中 | `stopping` |
| `stopping` | cleanup 実行中。追加 trigger は reason だけ記録し無視 | `stopped`, `force_exit` |
| `stopped` | cleanup 完了、exit 直前 | なし |
| `force_exit` | cleanup timeout 超過 | なし |

trigger 分類:

1. fatal: `uncaughtException`, `unhandledRejection`, `server.connect` error
2. external shutdown: `SIGTERM`, `SIGINT`
3. client disconnect: `stdin close`, `stdin end`, `stdin error`, transport close
4. parent loss: original parent PID dead / PPID changed to `1`

同時 trigger の決定規則:

- JavaScript event loop 上で最初に `requestShutdown(reason)` に入った trigger が state を `stopping` へ同期的に遷移させる。
- state が `stopping` になった後の trigger は cleanup と exit code を変更しない。
- 後続 trigger は structured log に `suppressedReason` として記録する。
- fatal trigger が cleanup 開始後に来た場合でも、追加 cleanup はしない。必要なら `fatalDuringShutdown: true` をログに残す。
- つまり実装は「最初の trigger が勝つ」。上の分類は exit code とログ severity の決定に使い、後から優先度で上書きしない。

### 2. child process をプロセスツリー単位で扱う

Bun が直接起動する process だけでなく、その下に Python/LLM/CLI がぶら下がる場合がある。PID 単体 kill では取りこぼす。

実装方針:

- `src/services/llm/spawnControl.ts` を `ProcessRegistry` 経由にする。
- macOS/Linux では async spawn に `detached: true` を指定し、child PID を process group id として扱う。
- process group 停止は `process.kill(-child.pid, signal)` を使う。`ESRCH` は停止済みとして扱う。
- group kill が失敗した場合は fallback として child PID 単体へ signal を送る。
- Windows は初期対応外とし、process group cleanup は best-effort PID kill に落とす。watchdog apply mode も macOS/Linux のみ有効化する。
- `AbortController` を使える spawn では `signal` を渡す。
- timeout 時は child 単体ではなく process group/tree を停止する。
- `spawnSync` は呼び出し中に親が終了すると cleanup が難しいため、Phase 3 ではまず長時間化しうる LLM 経路だけを async spawn へ寄せる。短時間の `rg` / diagnostic 系は対象外にする。
- grace period は `SIGTERM` から 3 秒、残存時 `SIGKILL` を標準値にする。LLM worker は env で延長可能にする。

### 3. PID file から process registry へ移行する

複数 MCP instance を許容するなら `.gnosis.pid` だけでは正確に監視できない。

推奨 registry:

```json
{
  "pid": 12345,
  "ppid": 987,
  "startedAt": "2026-04-28T08:00:00.000Z",
  "cwd": "/Users/y.noguchi/Code/gnosis",
  "argv": ["bun", "run", "src/index.ts"],
  "title": "gnosis-mcp-server",
  "role": "mcp-server",
  "heartbeatAt": "2026-04-28T08:00:05.000Z",
  "originalPpid": 987,
  "schemaVersion": 1
}
```

配置:

- 開発 repo 内の一時状態: `.gnosis/processes/*.json`
- ユーザー単位 daemon で共有する場合: `~/Library/Application Support/gnosis/processes/*.json`

初期実装では repo local の `.gnosis/processes/*.json` を使う。user-level registry は supervisor 移行時に再検討する。

registry I/O 仕様:

- ファイル名は `${role}-${pid}-${startedAtEpochMs}.json` とし、複数 instance で衝突しない。
- 書き込みは `${file}.tmp-${process.pid}` に JSON を書いてから `renameSync` する。
- heartbeat 更新も同じ temp write + rename で行う。
- 削除時は自分の `pid`, `startedAt`, `cwd`, `role` が一致する entry だけを削除する。
- 読み込み時に JSON parse error の entry は `corrupt` として扱い、watchdog dry-run で報告する。apply mode では削除だけ行い、kill はしない。
- `.gnosis.pid` は互換情報として残すが、watchdog の kill 判断には使わない。

registry failure policy:

- registry create に失敗しても MCP server の起動は止めない。MCP の正常終了を主対策とし、registry/watchdog は補助策だからである。
- create 失敗時は `registryStatus: "disabled"` を lifecycle manager に保持し、heartbeat と unregister を skip する。
- heartbeat write/rename に失敗した場合は `registryStatus: "degraded"` として WARN を出すが、process は継続する。
- degraded entry は watchdog apply mode の kill 対象にしない。dry-run で `registry_degraded` として報告する。
- unregister に失敗した場合は WARN のみ出す。残った entry は watchdog の stale metadata cleanup に任せる。
- `doctor` は registry create/write が失敗する環境を WARN として表示する。

## 軽量 watchdog daemon の評価

導入価値はある。ただし役割を限定する。

やること:

- registry に残る `gnosis-mcp-server` / `gnosis-tools` / `semantic-code-tools` / `gnosis-worker` を周期スキャンする。
- PID が存在しない registry entry を削除する。
- `ppid` が `1`、親 PID 不在、stdio client 不在、または idle TTL 超過の process を stale と判定する。
- stale process に `SIGTERM` を送り、短い猶予後に生存していれば `SIGKILL` する。
- kill した件数と理由を structured log に出す。

やらないこと:

- 任意の `bun` process を殺さない。
- OS の `Z` 状態 zombie を kill 対象にしない。
- DB migration や foreground test run を巻き込まない。
- LLM 推論中の worker を短い TTL で殺さない。

判定条件:

| 条件 | 判定 | Action |
| :--- | :--- | :--- |
| registry entry はあるが PID が存在しない | stale metadata | entry 削除 |
| PID は存在するが command/title が Gnosis と一致しない | PID reuse | entry 削除、kill しない |
| `ppid === 1` かつ role が MCP stdio server | orphan | graceful shutdown |
| original parent PID が消滅 | orphan | graceful shutdown |
| idle TTL 超過かつ client connection なし | stale | graceful shutdown |
| `ps` state が `Z` | zombie | kill せず記録。親側 reaping の不具合として扱う |

apply mode の pre-kill hard gate:

1. registry entry を読む。
2. `ps` で同じ PID の `ppid`, `stat`, `rss`, `command` を直前取得する。
3. `stat` が `Z` なら kill しない。
4. command または process title が Gnosis 既知パターンに一致しない場合は kill しない。
5. `cwd` が取得できる環境では registry の `cwd` と一致することを要求する。
6. `startedAt` より process elapsed time が短い場合は PID reuse とみなし kill しない。
7. stale 判定が 2 scan 連続で成立した場合だけ `SIGTERM` を送る。
8. `SIGKILL` は `SIGTERM` 後も同じ hard gate が成立した場合だけ送る。

identity 情報が読めない場合の既定動作:

- `ps` が失敗した場合、または PID が存在しない場合は kill しない。registry entry の削除だけを候補にする。
- command/title が読めない場合は kill しない。
- cwd が permission などで読めない場合は kill しない。ただし dry-run では `identity_incomplete` として表示する。
- elapsed time が読めない場合は kill しない。
- identity 情報が scan 間で変化した場合は PID reuse 疑いとして kill しない。
- すべての hard gate が読めて一致する場合だけ signal を送る。

既知パターン:

- title: `gnosis-mcp-server`, `gnosis-mcp-logic`, `gnosis-worker`
- command: `bun run src/index.ts`, `bun run src/scripts/mcpToolsServer.ts`, `bun run src/scripts/semanticCodeMcpServer.ts`, `bun run src/scripts/worker.ts`

false positive 対策:

- MCP stdio server の idle TTL は短めにできるが、worker/LLM は task timeout と同じか長くする。
- heartbeat が更新されている process は stale 扱いしない。
- `GNOSIS_PROCESS_WATCHDOG_APPLY=true` がない限り kill しない。
- launchd 登録も最初は dry-run plist のみ提供する。

## Golden Path

### 起動

1. `src/index.ts` が `process.title` を設定する。
2. lifecycle manager を `starting` で作成する。
3. ProcessRegistry に `mcp-server` entry を atomic create する。失敗時は `registryStatus: "disabled"` として WARN を出し、MCP 起動は継続する。
4. signal/stdin/parent-watch/cleanup timeout を登録する。
5. background workers は既定で起動対象になり、停止したい場合だけ `GNOSIS_ENABLE_AUTOMATION=false` を指定する。
6. `server.connect(transport)` を開始する。
7. connect 成功後に lifecycle state を `running` にする。
8. registry が enabled の場合だけ heartbeat interval を開始する。heartbeat 失敗時は `registryStatus: "degraded"` として WARN を出し、watchdog apply 対象から外す。

### 正常終了

1. stdin close/end または transport close が shutdown trigger になる。
2. state を `stopping` に遷移する。
3. heartbeat と parent-watch interval を止める。
4. active child process group に `SIGTERM` を送る。
5. `stopBackgroundWorkers()` を呼ぶ。
6. `closeDbPool()` を await する。
7. registry entry と互換 `.gnosis.pid` を削除する。削除失敗は WARN のみで終了を止めない。
8. state を `stopped` にし、exit code `0` で終了する。

### 異常終了

1. fatal trigger で state を `stopping` に遷移する。
2. cleanup timeout を 10 秒で開始する。
3. child process group cleanup、background worker stop、DB close、registry unregister を best-effort で実行する。
4. cleanup 完了なら exit code `1` で終了する。
5. timeout 超過なら `force_exit` として `process.exit(1)` する。

## 実装計画

### Phase 0: 計測

目的: 実際に残っているものが zombie か orphan/stale process かを切り分ける。

- `scripts/diagnose-processes.ts` を追加する。
- `ps -axo pid,ppid,stat,rss,etime,command` 相当を読み、Gnosis 関連 process だけを表示する。
- `doctor` に runtime process check を追加する。
- `bun run doctor` で stale registry / orphan / zombie-like state を WARN として出す。

完了条件:

- 「残っている Bun process の PID、PPID、STAT、RSS、起動経過時間、Gnosis role」が確認できる。

### Phase 1: MCP lifecycle manager

目的: MCP server が自力で終了する。

- `src/runtime/lifecycle.ts` を追加する。state machine、trigger priority、idempotent cleanup、cleanup timeout をここに閉じ込める。
- `src/index.ts` の signal/stdin/parent-watch cleanup を lifecycle manager に寄せる。
- cleanup callback に `stopBackgroundWorkers`、`closeDbPool`、registry unregister を登録する。
- `server.connect(transport)` の終了時も cleanup へ接続する。
- `src/scripts/mcpToolsServer.ts` と `src/scripts/semanticCodeMcpServer.ts` も同じ helper を使うか、最低限同じ shutdown trigger を揃える。

完了条件:

- MCP client を閉じると Bun process が数秒以内に消える。
- 親 process を強制終了しても MCP server が一定時間内に自決する。
- cleanup の二重実行で例外が出ない。

### Phase 2: ProcessRegistry

目的: 複数 instance を正確に追跡する。

- `src/runtime/processRegistry.ts` を追加する。
- `.gnosis.pid` は互換用に残すが、監視の一次情報は registry に移す。
- 起動時に `{ pid, ppid, cwd, argv, title, role, startedAt }` を記録する。
- 終了時に自分の entry だけ削除する。
- PID reuse を避けるため、`startedAt` と command/title を検証する。
- `.gnosis/processes/` を `.gitignore` に追加する。

完了条件:

- 複数 MCP server が同時起動しても registry entry が衝突しない。
- 古い `.gnosis.pid` が存在しても起動を阻害しない。

### Phase 3: child process cleanup

目的: Bun 配下の Python/LLM/CLI を取りこぼさない。

- `src/runtime/childProcesses.ts` を追加する。
- `runLlmProcess` の active PID Set を registry API に置き換える。
- timeout / shutdown 時に graceful terminate -> forced kill の順に停止する。
- 可能な経路から `spawnSync` を async spawn に移行する候補を洗い出す。

完了条件:

- LLM timeout 後に child/sibling process が残らない。
- MCP server 終了時に active child process が残らない。

### Phase 4: lightweight watchdog

目的: 取りこぼしを補助的に掃除する。

- `src/scripts/process-watchdog.ts` を追加する。
- `package.json` に `process:diagnose` と `process:watchdog` を追加する。
- `scripts/automation/com.gnosis.process-watchdog.plist` を追加する。
- デフォルトは dry-run で、`GNOSIS_PROCESS_WATCHDOG_APPLY=true` のときだけ kill する。
- scan interval は 60 秒程度、kill 対象は Gnosis registry entry に限定する。
- apply mode では pre-kill hard gate を必須にする。
- stale 判定は 2 scan 連続成立を要求する。

完了条件:

- dry-run で kill 候補と理由が確認できる。
- apply mode でも Gnosis 外の Bun process を kill しない。
- kill 実行ログから PID、role、reason、signal が追跡できる。

### Phase 5: supervisor との接続

目的: 既存の `docs/gnosis-supervisor-implementation-plan.md` と衝突させない。

- 本計画は短期安定化策として実装する。
- 1 ユーザー 1 supervisor に移行する場合、ProcessRegistry と lifecycle manager はそのまま supervisor/client の基盤に流用する。
- watchdog は supervisor 移行後も「supervisor 自身の取りこぼし検知」に縮小して残せる。

## テスト計画

Unit:

- lifecycle cleanup が一度だけ実行される。
- lifecycle trigger priority が fatal > signal > client disconnect > parent loss で安定する。
- cleanup timeout で `force_exit` に遷移する。
- parent-dead 判定が expected reason を返す。
- registry の create/remove が PID collision に耐える。
- registry の corrupt JSON は kill 対象にならない。
- watchdog が Gnosis 外 process を kill 対象にしない。
- watchdog apply mode が pre-kill hard gate 失敗時に signal を送らない。

Integration:

- `bun run src/index.ts` を child process として起動し、stdin を閉じると終了する。
- 親 process を kill したとき、子 MCP server が timeout 内に終了する。
- signal storm (`SIGTERM` と stdin close が近接) でも cleanup が一度だけ実行される。
- fake registry entry を作り、watchdog dry-run が stale metadata と判定する。
- fake Gnosis process と command mismatch PID reuse を作り、kill しないことを確認する。
- LLM spawn timeout 後に child process group が残らない。
- DB close が失敗しても registry unregister と child cleanup が実行される。

Manual:

```sh
bun run process:diagnose
bun run process:watchdog --dry-run
GNOSIS_PROCESS_WATCHDOG_APPLY=true bun run process:watchdog --once
```

## 受け入れ基準

- IDE/MCP client を終了した 10 秒後に、対応する `gnosis-mcp-server` Bun process が残らない。
- 1 日の通常利用後、registry に dead PID entry が残っても watchdog が削除できる。
- Gnosis 以外の `bun` process を kill しない。
- `bun run doctor` で orphan/stale process の有無が確認できる。
- cleanup による DB pool close と background worker stop が既存挙動を壊さない。
- watchdog apply mode は pre-kill hard gate を通過した process 以外に signal を送らない。
- `bun run lint` と関連 unit/integration test が通る。

## リスク

### 誤 kill

最大リスク。対象を registry entry に限定し、さらに process title / command / cwd を照合する。初期リリースは dry-run default にする。

### zombie という語の混乱

`Z` 状態の zombie は kill できない。ドキュメントとログでは `zombie` と `orphan/stale` を分ける。

### long-running LLM の誤判定

role ごとに TTL を分ける。MCP stdio server は短め、worker/LLM は task timeout と連動させる。

### supervisor 計画との重複

本計画は短期の lifecycle hardening。supervisor は中長期の常駐 architecture。共通部品を `src/runtime/*` に置くことで移行時の捨て戻しを避ける。

## Rollback

- Phase 1 の lifecycle manager は `GNOSIS_RUNTIME_LIFECYCLE_LEGACY=true` で旧 `src/index.ts` 相当の cleanup に戻せるようにする。
- Phase 2 の ProcessRegistry は `.gnosis.pid` 互換を維持するため、問題があれば registry 登録だけを無効化できる。
- Phase 4 の watchdog は dry-run default のため、apply mode を無効化するだけで kill 動作を止められる。
- launchd plist は導入スクリプトで unload/remove を提供する。

## 推奨優先順位

1. Phase 0 と Phase 1 を先に実施する。ここで多くの残存 process は解消する可能性が高い。
2. Phase 2 で複数 instance と監視の土台を整える。
3. Phase 3 で LLM/child process の取りこぼしを潰す。
4. Phase 4 の watchdog は dry-run から導入し、ログで安全性を確認してから apply mode を有効化する。
5. Phase 5 の supervisor は、MCP instance 数や DB connection 重複が継続して問題になる場合に進める。
