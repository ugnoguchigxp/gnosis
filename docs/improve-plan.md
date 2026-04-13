# Gnosis 改善実装計画

> 対象: ローカル実行環境 (Mac M4)
> 作成: 2026-04-13
> CI/CD は対象外（ローカル `verify` パイプラインで品質を担保する方針）

---

## Phase 1: コード品質の底上げ（即効性が高い）

### 1.1 `mcp/server.ts` の分割

**課題**: 598行の単一ファイルに Zod スキーマ定義・ツール一覧・全ハンドラの switch が同居しており、ツール追加のたびに肥大化する。

**実装**:

```
src/mcp/
  server.ts          # Server 初期化 + ListTools + CallTool ディスパッチ（100行以下）
  registry.ts        # ToolDefinition 型と登録ヘルパー
  tools/
    index.ts         # 全ツールを集約して export
    memory.ts        # store_memory, search_memory, delete_memory
    graph.ts         # query_graph, digest_text, update_graph, find_path, build_communities
    knowledge.ts     # search_knowledge, get_knowledge, search_unified
    knowflow.ts      # enqueue_knowledge_task, run_knowledge_worker
    experience.ts    # record_experience, recall_lessons
    sync.ts          # sync_agent_logs, reflect_on_memories
    guidance.ts      # register_guidance
```

各ツールファイルは `{ schema, definition, handler }` を export する統一型:

```typescript
// src/mcp/registry.ts
import type { z } from 'zod';

export interface ToolEntry<T extends z.ZodType> {
  name: string;
  description: string;
  schema: T;
  handler: (input: z.infer<T>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}
```

`server.ts` は `tools/index.ts` から集約した配列を走査して `ListTools` と `CallTool` を生成:

```typescript
// server.ts (概要)
import { toolEntries } from './tools/index.js';

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolEntries.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const entry = toolEntries.find((t) => t.name === name);
  if (!entry) throw new Error(`Unknown tool: ${name}`);
  try {
    const input = entry.schema.parse(args);
    return await entry.handler(input);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error executing tool: ${message}` }], isError: true };
  }
});
```

**検証**: `bun run verify` が既存テスト (`test/mcpContract.test.ts`) を含めて全パス。

---

### 1.2 `bun-types` のバージョン固定

**課題**: `"bun-types": "latest"` は `bun install` 再実行時に予期しない型変更を引き込むリスクがある。

**実装**:

```bash
# 現在ロックされているバージョンを確認
bun pm ls | grep bun-types

# package.json を固定バージョンに更新 (例)
# "bun-types": "1.3.12"
```

**所要時間**: 5分

---

### 1.3 `allowJs: true` の除去

**課題**: `tsconfig.json` で `allowJs: true` だが、ルートの `.js` ファイルは `setup_db.js` のみ。これは `node setup_db.js` で直接実行されており tsc の対象外にできる。

**実装**:

1. `setup_db.js` を `setup_db.ts` にリネーム（型を付与）するか、`tsconfig.json` の `exclude` に追加
2. `allowJs: true` を削除
3. `bun x tsc --noEmit` で他に JS ファイルがないことを確認

**所要時間**: 15分

---

### 1.4 Biome の VCS 連携有効化

**課題**: `biome.json` で `vcs.useIgnoreFile: false` のため、`.gitignore` と Biome の除外リストを手動で二重管理している。

**実装**:

```jsonc
// biome.json
{
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  }
}
```

`files.ignore` から `.gitignore` と重複するエントリ (`node_modules`, `dist`, `.bun`) を削除し、Biome 固有の除外（`services/**/models` 等）のみ残す。

**検証**: `bun run lint` の対象ファイル一覧に差分がないことを確認。

**所要時間**: 10分

---

## Phase 2: 信頼性の強化

### 2.1 テストカバレッジの可視化

**課題**: テストは26ファイル存在するが、カバレッジ率が不明でどこが薄いか判断できない。

**実装**:

1. `package.json` にカバレッジスクリプトを追加:

```jsonc
{
  "scripts": {
    "test:coverage": "bun test --coverage --coverage-reporter=lcov --coverage-reporter=text",
    "test:coverage:summary": "bun test --coverage"
  }
}
```

2. `.gitignore` に `coverage/` を追加

3. `scripts/verify.ts` の `test` ステップを `test:coverage:summary` に変更して、verify 時にカバレッジサマリを表示:

```typescript
{ name: 'test', command: bun, args: ['test', '--coverage'] },
```

**成果物**: ターミナルにカバレッジサマリが出力され、`lcov` レポートでファイル単位の詳細を確認可能。

**所要時間**: 20分

---

### 2.2 Python 依存のロックファイル導入

**課題**: `services/embedding/requirements.txt` と `services/local-llm/requirements.txt` が `>=` のみで、再現性がない。

**実装**:

```bash
# 各サービスで uv を使用してロック
cd services/embedding
uv pip compile requirements.txt -o requirements.lock

cd ../local-llm
uv pip compile requirements.txt -o requirements.lock
```

`scripts/setup-services.sh` を更新し、`requirements.lock` が存在する場合はそちらからインストール:

```bash
if [ -f requirements.lock ]; then
  pip install -r requirements.lock
else
  pip install -r requirements.txt
fi
```

`.gitignore` に `*.lock` が Python ロックに影響しないことを確認（Bun の `bun.lock` と区別）。

**所要時間**: 30分

---

### 2.3 テスト不足領域の補強

**課題**: 現在のテストは KnowFlow に集中（24件中18件）。以下の領域にテストがないか薄い:

| 領域 | 現状 | 目標 |
|------|------|------|
| `services/memory.ts` | spec あり（統合テスト寄り） | ユニットテスト追加 |
| `services/graph.ts` | spec あり（統合テスト寄り） | エッジケース追加 |
| `services/guidance.ts` | なし | 基本 CRUD テスト |
| `services/experience.ts` | なし | 記録・検索の往復テスト |
| `services/community.ts` | なし | コミュニティ検出のスナップショットテスト |
| `services/synthesis.ts` | なし | モック LLM での統合テスト |
| `adapters/llm.ts` | なし | リトライ・タイムアウト・CLI フォールバックのテスト |
| `config.ts` | なし | 環境変数パース・デフォルト値のテスト |

**優先順位** (影響度×テスト容易性):

1. `config.ts` — 環境変数のパースミスは全体に波及。純関数的でテストしやすい
2. `adapters/llm.ts` — 外部依存のリトライロジック。モックで検証可能
3. `services/guidance.ts` — 新しめの機能で回帰リスクが高い
4. `services/experience.ts` — 失敗学習の中核

**所要時間**: 各領域 30〜60分、全体で 1〜2日

---

## Phase 3: セキュリティと堅牢性

### 3.1 Tauri CSP の適切な設定

**課題**: `tauri.conf.json` で `"csp": null` → WebView 内での XSS に対する防御がない。

**実装**:

```jsonc
// apps/monitor/src-tauri/tauri.conf.json
{
  "app": {
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:* http://127.0.0.1:*; img-src 'self' data:"
    }
  }
}
```

ポイント:
- `default-src 'self'` でベースラインを制限
- `connect-src` にローカル API エンドポイント（MCP stdio 経由の localhost）を許可
- `style-src 'unsafe-inline'` は Svelte のスコープ付きスタイルに必要
- 外部 CDN は不許可（ローカル実行前提）

**検証**: `bun run monitor:dev` で UI が正常動作することを確認。コンソールに CSP 違反が出ないこと。

**所要時間**: 30分（動作確認含む）

---

### 3.2 Docker Compose のセキュリティ強化

**課題**: デフォルト `postgres/postgres` でポートが公開されている。ローカルとはいえ、ネットワーク接続時にリスク。

**実装**:

```yaml
# docker-compose.yml
services:
  db:
    # ...
    ports:
      - "127.0.0.1:7888:5432"  # localhost のみにバインド
    environment:
      POSTGRES_PASSWORD: ${GNOSIS_DB_PASSWORD:-postgres}
```

`127.0.0.1` プレフィックスにより、外部ネットワークからの接続を遮断。パスワードは環境変数で上書き可能にする。

**所要時間**: 10分

---

### 3.3 インジェスト処理のシークレットフィルタ強化

**課題**: `services/ingest.ts` にシークレット除外ロジックがあるが、パターンが限定的。

**実装**:

除外パターンを正規表現リストとして外出しし、テスト可能にする:

```typescript
// src/utils/secretFilter.ts
export const SECRET_PATTERNS: RegExp[] = [
  /password\s*[:=]/i,
  /secret[_-]?key\s*[:=]/i,
  /auth[_-]?token\s*[:=]/i,
  /api[_-]?key\s*[:=]/i,
  /bearer\s+[a-z0-9\-_.]+/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\sKEY-----/,
];

export const containsSecret = (line: string): boolean =>
  SECRET_PATTERNS.some((pattern) => pattern.test(line));
```

テストを追加してカバレッジを確保。

**所要時間**: 45分

---

## Phase 4: アーキテクチャの改善

### 4.1 サービス層の依存注入パターン統一

**課題**: 一部のサービス（`knowflow`）は Repository パターンで依存を注入しているが、`memory.ts`・`graph.ts` は `db` をモジュールスコープで直接 import している。テスト時にモック差し替えが困難。

**実装**:

```typescript
// 現状: モジュールスコープで db を直接使用
import { db } from '../db/index.js';
export const saveMemory = async (...) => { /* db を直接参照 */ };

// 改善: ファクトリ関数で依存を注入
export const createMemoryService = (database: typeof db) => ({
  save: async (...) => { /* database を使用 */ },
  search: async (...) => { /* database を使用 */ },
  delete: async (...) => { /* database を使用 */ },
});

// デフォルトインスタンスも export（後方互換）
export const memoryService = createMemoryService(db);
```

**移行戦略**: 後方互換の re-export を維持しつつ、新規コードは `createXxxService()` を使用。テストではモック DB を注入。

**対象ファイル**:
- `src/services/memory.ts`
- `src/services/graph.ts`
- `src/services/experience.ts`
- `src/services/guidance.ts`

**所要時間**: 各ファイル 30〜60分、全体で半日

---

### 4.2 エラー型の構造化

**課題**: サービス層のエラーは `throw new Error(message)` のみで、呼び出し側がエラーの種別（not found / validation / timeout 等）を判別できない。

**実装**:

```typescript
// src/domain/errors.ts
export class GnosisError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusHint: 'not_found' | 'validation' | 'timeout' | 'internal' = 'internal',
  ) {
    super(message);
    this.name = 'GnosisError';
  }
}

export class NotFoundError extends GnosisError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 'not_found');
  }
}

export class ValidationError extends GnosisError {
  constructor(message: string) {
    super(message, 'VALIDATION', 'validation');
  }
}

export class TimeoutError extends GnosisError {
  constructor(operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`, 'TIMEOUT', 'timeout');
  }
}
```

MCP のエラーハンドラで `statusHint` を活用し、クライアントにより有用なエラー情報を返す。

**所要時間**: 2〜3時間

---

## Phase 5: 開発体験の向上

### 5.1 リリース管理の導入

**課題**: タグ・バージョン管理がなく、どの時点のコードが安定版か判別できない。

**実装**:

手動でのセマンティックバージョニング運用:

```bash
# リリースフロー
git tag -a v0.1.0 -m "Initial stable release"
git tag -a v0.2.0 -m "KnowFlow integration + Guidance Registry"
```

`package.json` の `version` と git tag を同期させる npm スクリプト:

```jsonc
{
  "scripts": {
    "release": "bun run verify && git tag -a v$(node -p \"require('./package.json').version\") -m \"Release v$(node -p \"require('./package.json').version\")\" && echo 'Tagged. Run git push --tags to publish.'"
  }
}
```

**所要時間**: 15分

---

### 5.2 verify スクリプトの強化

**課題**: 現在の verify は lint → typecheck → test → smoke の4ステップ。カバレッジやフォーマットチェックが含まれていない。

**実装**:

```typescript
const steps: Array<{ name: string; command: string; args: string[] }> = [
  { name: 'format-check', command: bun, args: ['run', 'biome', 'format', '--check', '.'] },
  { name: 'lint', command: bun, args: ['run', 'lint'] },
  { name: 'typecheck', command: bun, args: ['x', 'tsc', '--noEmit'] },
  { name: 'test', command: bun, args: ['test', '--coverage'] },
  { name: 'smoke', command: bun, args: ['scripts/smoke.ts'] },
];
```

**所要時間**: 15分

---

## 実装ロードマップ

| 優先度 | タスク | 所要時間 | Phase |
|:---:|--------|:---:|:---:|
| 🔴 | 1.1 mcp/server.ts 分割 | 2〜3h | 1 |
| 🔴 | 1.2 bun-types 固定 | 5min | 1 |
| 🔴 | 1.4 Biome VCS 連携 | 10min | 1 |
| 🟡 | 2.1 テストカバレッジ可視化 | 20min | 2 |
| 🟡 | 2.2 Python 依存ロック | 30min | 2 |
| 🟡 | 3.1 Tauri CSP 設定 | 30min | 3 |
| 🟡 | 3.2 Docker localhost バインド | 10min | 3 |
| 🟢 | 1.3 allowJs 除去 | 15min | 1 |
| 🟢 | 2.3 テスト補強 | 1〜2d | 2 |
| 🟢 | 3.3 シークレットフィルタ強化 | 45min | 3 |
| 🟢 | 4.1 依存注入パターン統一 | 半日 | 4 |
| 🟢 | 4.2 エラー型の構造化 | 2〜3h | 4 |
| 🟢 | 5.1 リリース管理 | 15min | 5 |
| 🟢 | 5.2 verify 強化 | 15min | 5 |

🔴 = 最優先（保守性に直結）　🟡 = 高優先（信頼性向上）　🟢 = 中優先（長期的な品質投資）

---

## 完了基準

各タスク完了時に以下を満たすこと:

1. `bun run verify` が全ステップ通過
2. 既存テストに回帰がない
3. 変更内容を Conventional Commits 形式でコミット
