# Gnosis 改善実装計画 v2

> 対象: ローカル実行環境 (Mac M4)
> 作成: 2026-04-13
> 前版からの更新: Phase 1〜3, Phase 5 の大部分は適用済み。残課題と新規課題を整理。
> CI/CD は対象外（ローカル `verify` パイプラインで品質を担保する方針）

---

## 前版（v1）の適用状況

| 項目 | 状態 | 備考 |
|------|:----:|------|
| 1.1 MCP server.ts 分割 | ✅ | 45行 + tools/ 8ファイル (582行) + registry.ts |
| 1.2 bun-types 固定 | ✅ | `1.3.12` に固定 |
| 1.3 allowJs 除去 | ✅ | `allowJs` 削除、`setup_db.js` は exclude |
| 1.4 Biome VCS 連携 | ✅ | `useIgnoreFile: true` |
| 2.1 カバレッジ可視化 | ✅ | verify に `--coverage` 組み込み |
| 2.2 Python 依存ロック | ✅ | `requirements.lock` + setup-services.sh 対応 |
| 2.3 テスト補強 | ⚠️ | llm / experience / guidance は追加済み、**config は未着手** |
| 3.1 Tauri CSP | ✅ | 具体的な CSP 文字列設定済み |
| 3.2 Docker localhost バインド | ✅ | `127.0.0.1` + 環境変数化 |
| 3.3 シークレットフィルタ | ✅ | `secretFilter.ts` + テスト |
| 4.1 DI 統一 | ⚠️ | guidance の一部は DI 対応、**サービス全体は未統一** |
| 4.2 エラー型構造化 | ⚠️ | `GnosisError` 定義済み、**KnowFlow 系で `Error` 混在** |
| 5.1 リリース管理 | ⚠️ | `release` スクリプト定義済み、**タグ 0 件・CHANGELOG なし** |
| 5.2 verify 強化 | ✅ | format-check + lint + typecheck + test + smoke |

---

## Phase 1: ドキュメント整備（最優先）

プロジェクトの価値を対外的に伝え、新規参加者のオンボーディングコストを下げる。

### 1.1 README の全面改訂

**課題**: 現 README は最小限のセットアップ手順のみ。プロジェクトの全体像・設計思想・MCP ツール一覧・環境変数リファレンスが欠落。

**実装内容**:

- アーキテクチャ概要セクション（テキスト図で Core / Monitor / Embedding / LLM の関係を図示）
- MCP ツール一覧（18ツール）と簡潔な説明テーブル
- 環境変数リファレンス（カテゴリ別）
- KnowFlow CLI の全コマンド解説
- プロファイル設定の説明
- 開発ワークフロー（verify / test / lint）
- トラブルシューティングセクション

**所要時間**: 1〜2時間

---

### 1.2 MCP ツール API リファレンスの作成

**課題**: MCP ツール（18個）の入出力仕様が分散しており、利用者がどのツールを使えばよいか判断できない。

**実装**: `docs/mcp-tools.md` を新規作成

```markdown
# MCP Tools API Reference

## Memory
### store_memory
- 用途: 汎用的な観察・知見・レビュー結果の永続化
- 入力: sessionId, content, metadata?, entities?, relations?
- 出力: Memory stored successfully with ID: <uuid>

### search_memory
- 用途: セマンティック類似検索
- 入力: sessionId, query, limit?, filter?
...
```

各ツールについて以下を記載:
- **用途**: どういう場面で使うか（1〜2文）
- **入力パラメータ**: 名前・型・必須/任意・デフォルト値
- **出力**: 返却されるデータの形式
- **使い分けガイド**: 類似ツール間の違い（例: `search_memory` vs `search_knowledge` vs `search_unified`）

**所要時間**: 2〜3時間

---

### 1.3 アーキテクチャドキュメントの作成

**課題**: プロジェクトの設計判断・データフロー・コンポーネント間の依存関係が暗黙知。

**実装**: `docs/architecture.md` を新規作成

記載内容:
- **設計思想**: ローカルファースト、MCP 標準、PostgreSQL 一元化
- **コンポーネント図**: Core ↔ MCP Client / Embedding Service / Local LLM / Monitor
- **データフロー**: テキスト → 埋め込み → pgvector 保存 → 類似検索の流れ
- **DB スキーマ概要**: 10テーブルの役割と関連
- **KnowFlow パイプライン**: enqueue → poll → LLM task → merge → knowledge tables
- **Graph RAG**: エンティティ/リレーション → graphology → コミュニティ検出
- **Guidance Registry**: ZIP インポート → チャンク化 → ベクトル検索 → プロンプト注入
- **技術選択の理由**: なぜ Bun か、なぜ Drizzle か、なぜ pgvector か

**所要時間**: 2〜3時間

---

### 1.4 環境変数・設定リファレンスの作成

**課題**: `config.ts` に 50 以上の環境変数が定義されているが、`.env.example` や README に全量の説明がない。

**実装**: `docs/configuration.md` を新規作成

カテゴリ別に整理:

| カテゴリ | 変数例 | 説明 |
|----------|--------|------|
| データベース | `DATABASE_URL` | PostgreSQL 接続文字列 |
| 埋め込み | `GNOSIS_EMBED_COMMAND` | ベクトル生成コマンドのパス |
| LLM | `LOCAL_LLM_API_BASE_URL` | ローカル LLM API のベース URL |
| KnowFlow | `KNOWFLOW_WORKER_*` | ワーカー設定 |
| Guidance | `GUIDANCE_*` | ガイダンスレジストリ設定 |

加えて、`profiles/default.toml` のフォーマットと各フィールドの説明。

**所要時間**: 1時間

---

### 1.5 KnowFlow 運用ガイドの作成

**課題**: KnowFlow は CLI コマンドが 8 つあり、プロファイル・予算・評価スイートなど概念が多いが、統一的な説明がない。

**実装**: `docs/knowflow-guide.md` を新規作成

記載内容:
- KnowFlow の概念説明（タスク、フロー、予算、プロファイル）
- CLI コマンド全 8 種の詳細（enqueue / run-once / run-worker / llm-task / search-knowledge / get-knowledge / merge-knowledge / eval-run）
- フラグ一覧と使用例
- 評価スイート（`eval/suites/local.json`）の構造と拡張方法
- TOML プロファイルのカスタマイズ方法
- トラブルシューティング（LLM 接続エラー、キュー滞留など）

**所要時間**: 1〜2時間

---

### 1.6 既存設計ドキュメントの整理

**課題**: `docs/` に 5 本の計画書があるが、完了済み・進行中・未着手の区別がつかない。

**実装**:

- `knowflow-integration-refactor-plan.md`: 冒頭に **[完了]** ステータスを明記（すでに「完了済み」と本文にある）
- `tauri-monitoring-implementation-plan.md`: 実装状況の追記（雛形は完成、Collector/WS は実装済みなど）
- `security-news.md`: ステータス追記（未着手 or 部分実装）
- `knowflow-kg-fts-unified-plan.md`: 実装状況の追記

**所要時間**: 30分

---

## Phase 2: コード品質の残課題

### 2.1 `config.ts` のユニットテスト

**課題**: 50 以上の環境変数パースと Zod バリデーションを持つ `config.ts` に専用テストがない。パースミスは全体に波及する。

**実装**:

```typescript
// test/config.test.ts
import { describe, test, expect } from 'bun:test';

describe('envBoolean', () => {
  test('"1" → true', ...);
  test('"false" → false', ...);
  test('undefined → fallback', ...);
});

describe('envNumber', () => {
  test('valid number string', ...);
  test('NaN → fallback', ...);
});

describe('LlmClientConfigSchema', () => {
  test('valid config passes', ...);
  test('invalid URL rejects', ...);
});
```

`config` オブジェクト自体はモジュール評価時に構築されるため、ヘルパー関数（`envBoolean` / `envNumber`）を export してテスト対象にする。

**所要時間**: 1時間

---

### 2.2 カバレッジ閾値の導入

**課題**: `verify` でカバレッジを出力しているが、閾値がないため低下に気づけない。

**実装**: `scripts/verify.ts` のテストステップ後にカバレッジサマリの出力をパースし、全体カバレッジが閾値未満なら警告を出す。

```typescript
const COVERAGE_WARN_THRESHOLD = 60;
```

当面は **warn のみ**（ブロックしない）。安定したら enforce に昇格。

**所要時間**: 30分

---

### 2.3 `guidance.ts` の分割

**課題**: 871行の単一ファイルに、ZIP インポート・チャンク処理・手動登録・検索・ユーティリティが混在。

**実装**:

```
src/services/guidance/
  index.ts           # 公開 API の re-export
  import.ts          # ZIP インポートロジック（importGuidanceArchives 等）
  register.ts        # 手動登録（registerGuidance）
  search.ts          # 検索・フィルタリング
  types.ts           # 型定義・Zod スキーマ
```

**移行戦略**: `src/services/guidance.ts` → `src/services/guidance/index.ts` で re-export し、既存の import パスを維持。

**所要時間**: 2〜3時間

---

### 2.4 `setup_db.js` の TypeScript 化

**課題**: ルートに残る唯一の JS ファイル。`tsconfig.json` の `exclude` で回避しているが技術的負債。

**実装**:
1. `setup_db.js` → `setup_db.ts` にリネーム
2. 型アノテーションを追加
3. `package.json` の `db:init` を `bun run setup_db.ts` に更新
4. `tsconfig.json` の `exclude` から `setup_db.js` を削除

**所要時間**: 15分

---

## Phase 3: アーキテクチャの改善

### 3.1 サービス層の DI 統一

**課題**: `memory.ts` / `graph.ts` / `experience.ts` / `knowledge.ts` / `sync.ts` / `community.ts` が `db` をモジュールスコープで直接 import。テスト時のモック差し替えが困難。

**現状**: `guidance.ts` の `registerGuidance` は `deps` パラメータで DI 対応済み。KnowFlow の Repository も注入可能。

**実装**: v1 計画と同じファクトリパターンを段階的に適用。

```typescript
export const createMemoryService = (database: typeof db) => ({
  save: async (...) => { ... },
  search: async (...) => { ... },
});

// 後方互換
export const memoryService = createMemoryService(db);
```

**対象ファイル（優先順）**:
1. `memory.ts` (275行) — テストが最も恩恵を受ける
2. `experience.ts` (124行) — 小さく移行しやすい
3. `graph.ts` (439行) — テスト容易性の大きな改善
4. `knowledge.ts` (139行)
5. `sync.ts` (275行)
6. `community.ts` (90行)

**所要時間**: 各ファイル 30〜60分、全体で半日〜1日

---

### 3.2 `GnosisError` の全面適用

**課題**: `GnosisError` / `NotFoundError` / `ValidationError` / `TimeoutError` は定義済みだが、KnowFlow 系や一部サービスで素の `Error` が多用されている。

**対象箇所の例**:
- `knowflow/flows/userFlow.ts`: `throw new Error('USER_BUDGET exceeded: ...')`
- `knowflow/flows/cronFlow.ts`: `throw new Error('CRON_BUDGET exceeded: ...')`
- `knowflow/utils/profile.ts`: 複数の `throw new Error(TOML parse errors)`
- `services/knowledge.ts`: `catch` ブロックで `console.error` のみ

**実装方針**:
- 予算超過 → `ValidationError`
- TOML パースエラー → `ValidationError`
- リソース未発見 → `NotFoundError`
- LLM タイムアウト → `TimeoutError`
- 必要に応じてドメイン固有エラーを追加（例: `BudgetExceededError extends GnosisError`）

**所要時間**: 2〜3時間

---

## Phase 4: 運用の成熟

### 4.1 初回リリースタグの作成

**課題**: `release` スクリプトは用意されているが、タグが 0 件で実際のリリースが行われたことがない。

**実装**:
1. 現時点の `package.json` version (`0.1.0`) で初回タグを打つ
2. 簡易的な CHANGELOG.md を作成（これまでの主要マイルストーン）
3. 以降のリリースフローを README に記載

**所要時間**: 30分

---

### 4.2 `.env.example` の充実

**課題**: `.env.example` が最小限で、`config.ts` で定義された多数の環境変数のうちどれが重要か分からない。

**実装**: `config.ts` の全環境変数を `.env.example` にコメント付きで列挙。必須・推奨・オプションの3段階で分類。

**所要時間**: 30分

---

### 4.3 launchd 自動化ドキュメント

**課題**: `scripts/automation/` に 5 つの plist ファイルがあるが、セットアップ手順が不明確。

**実装**: `docs/automation.md` を新規作成。各 plist の役割・インストール手順・ログ確認方法を記載。

**所要時間**: 30分

---

## 実装ロードマップ

| 優先度 | タスク | 所要時間 | Phase |
|:---:|--------|:---:|:---:|
| 🔴 | 1.1 README 全面改訂 | 1〜2h | 1 |
| 🔴 | 1.2 MCP ツール API リファレンス | 2〜3h | 1 |
| 🔴 | 1.3 アーキテクチャドキュメント | 2〜3h | 1 |
| 🔴 | 1.4 環境変数・設定リファレンス | 1h | 1 |
| 🟡 | 1.5 KnowFlow 運用ガイド | 1〜2h | 1 |
| 🟡 | 1.6 既存設計ドキュメント整理 | 30min | 1 |
| 🟡 | 2.1 config.ts テスト | 1h | 2 |
| 🟡 | 2.2 カバレッジ閾値 | 30min | 2 |
| 🟡 | 2.3 guidance.ts 分割 | 2〜3h | 2 |
| 🟢 | 2.4 setup_db.js の TS 化 | 15min | 2 |
| 🟢 | 3.1 DI 統一 | 半日〜1日 | 3 |
| 🟢 | 3.2 GnosisError 全面適用 | 2〜3h | 3 |
| 🟢 | 4.1 初回リリースタグ | 30min | 4 |
| 🟢 | 4.2 .env.example 充実 | 30min | 4 |
| 🟢 | 4.3 launchd 自動化ドキュメント | 30min | 4 |

🔴 = 最優先（プロジェクト価値の可視化） 🟡 = 高優先（品質基盤） 🟢 = 中優先（長期投資）

---

## 成果物一覧（新規ドキュメント）

| ファイル | 内容 |
|----------|------|
| `README.md` | プロジェクト全体の入口（大幅改訂） |
| `docs/mcp-tools.md` | MCP ツール 18 種の API リファレンス |
| `docs/architecture.md` | アーキテクチャ概要・設計判断・データフロー |
| `docs/configuration.md` | 環境変数・プロファイル・設定リファレンス |
| `docs/knowflow-guide.md` | KnowFlow の概念・CLI・評価・運用ガイド |
| `docs/automation.md` | launchd 自動化のセットアップガイド |
| `CHANGELOG.md` | リリース履歴 |

---

## 完了基準

各タスク完了時に以下を満たすこと:

1. `bun run verify` が全ステップ通過
2. 既存テストに回帰がない
3. ドキュメントの内容が `src/` の実装と一致している（特にツール名・パラメータ）
4. 変更内容を Conventional Commits 形式でコミット
