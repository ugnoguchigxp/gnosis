# Startup Improvement Plan (Status-Tracked)

最終更新: 2026-04-24 (implemented)

## 目的

`git clone` 直後の利用者が、過度な前提知識なしで Gnosis を起動し、最小限の価値確認まで到達できる導線を維持する。

## 現状スナップショット

`docs/startup.md` の初版で定義した 6 フェーズに対する、現時点の実装状況は以下。

| フェーズ | 状態 | 実装メモ |
| :--- | :--- | :--- |
| 1. README 最短導線化 | 完了 | README 先頭を minimal 導線中心に再構成。 |
| 2. env 分割 | 完了 | `.env.minimal` / `.env.local-llm` / `.env.cloud-review` を揃え、`.env.example` は入口化。 |
| 3. bootstrap | 完了 | `bootstrap` を minimal 用に再編。`bootstrap:local-llm` を分離。 |
| 4. doctor | 完了 | `bun run doctor` と `scripts/doctor.ts` を追加。 |
| 5. onboarding:smoke | 完了 | `bun run onboarding:smoke` と `scripts/onboarding-smoke.ts` を追加。 |
| 6. fresh clone CI | 完了 | `.github/workflows/onboarding.yml` を追加。 |

## 実装結果

- 導入コマンドを `bootstrap` / `doctor` / `onboarding:smoke` に整理
- README 冒頭で minimal 導線を固定
- 導線を fresh clone CI に接続
- MCP 公開面は既定 `primary`（Agent-First）。legacy クライアント互換時は `GNOSIS_MCP_TOOL_EXPOSURE=all` を使用

## 実装バックログ（完了）

### Phase A: 最小導線の再定義

- [x] `README.md` 冒頭を「最小構成 5 分」に置換
- [x] 導入パスを `minimal` / `local-llm` / `cloud-review` の 3 本に固定
- [x] 失敗しやすい項目（Docker 未起動、`.env` 未生成、DB 未初期化）を README 冒頭に短く追加

完了条件:
- README 冒頭だけで `minimal` 導入が完結する

### Phase B: env テンプレート整理

- [x] `.env.minimal` を追加（DB + embedding 最低限）
- [x] `.env.cloud-review` を追加（cloud reviewer 必須項目のみ）
- [x] `.env.example` を「構成別テンプレートへの入口」に変更
- [x] `docs/configuration.md` に「構成→必要 env」対応表を追加

完了条件:
- 初回利用者が「今この値は必要か」を判断せずに開始できる

### Phase C: bootstrap 再編

- [x] `bun run bootstrap` を最小構成専用に変更
- [x] `bun run bootstrap:local-llm` を追加（既存の local-llm 手順を移設）
- [x] `.env` が既存の場合は上書きせず警告する現在仕様を維持
- [x] 失敗メッセージに「再実行コマンド」を必ず含める

完了条件:
- fresh clone で `bun run bootstrap` だけで minimal が成立する

### Phase D: doctor / smoke / CI

- [x] `bun run doctor` 追加（`OK/WARN/FAIL` + fix command）
- [x] `bun run onboarding:smoke` 追加（DB接続 / pgvector / seed marker / MCP最小起動）
- [x] `.github/workflows/onboarding.yml` 追加
- [x] CI の手順を README と一致させる

完了条件:
- 手元と CI の両方で onboarding 成否が同一コマンドで判定できる

## 受け入れ指標

- 導入コマンドが 3 本以内に収まる: `bootstrap`, `doctor`, `onboarding:smoke`
- README と CI の導線が一致している
- local-llm は任意導線として後置され、minimal の成功率を下げない

## リスクと対策

### `bootstrap` 肥大化

- 対策: minimal と local-llm をコマンド分離して責務を固定する

### 既存利用者との互換性低下

- 対策: 旧 `.env.example` は残し、段階的にテンプレート誘導へ移す

### Windows 展開困難化

- 対策: 新規実装は Bun/TypeScript 優先、`docker compose` と `docker-compose` 差異は吸収する
