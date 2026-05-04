# Gnosis Monitor (Tauri + SvelteKit)

ローカルの `gnosis` データを監視するデスクトップ UI です。

## 開発

```sh
# from repository root
bun run monitor:dev
```

または個別起動:

```sh
cd apps/monitor
bun run tauri:dev
```

## ビルド

```sh
cd apps/monitor
bun run tauri:build
```

## Snapshot CLI

Rust Collector から呼び出す集計 CLI:

```sh
bun run monitor:snapshot
```

タスク詳細取得 CLI:

```sh
bun run monitor:detail --task-id <task-id>
```

出力内容:
- Queue: `pending/running/deferred/failed`
- Worker: `lastSuccessTs/lastFailureTs/consecutiveFailures`
- Eval: `passRate/passed/failed`
