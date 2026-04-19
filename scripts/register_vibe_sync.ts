import { closeDbPool } from '../src/db/index.js';
import { saveGuidance } from '../src/services/guidance/register.js';

const SKILLS = [
  {
    title: 'CLI 引数の安全な保護',
    content:
      "外部コマンド実行時、`--` 以降を位置引数として明示することで、AI 生成テキスト中のハイフンによるフラグ誤認識とインジェクションを完全に防ぐ。例: `spawn(command, ['--', text])`",
    tags: ['cli', 'security', 'spawn'],
    applicability: { signals: ['spawn', 'exec', 'child_process'] },
  },
  {
    title: 'MCP stdout 汚染の完全回避',
    content:
      'MCP サーバー実装において、`stdout` は通信プロトコルとして予約されているため、開発ログやデバッグ出力は 100% `stderr` (`console.error`) に流すことを鉄則とする。',
    tags: ['mcp', 'logging', 'debug'],
    applicability: { signals: ['mcp', 'server', 'console.log'] },
  },
  {
    title: '信頼性の高い JSON 抽出法',
    content:
      'LLM の出力は常に不安定であることを前提とし、正規表現を使用してテキストから最初の `{}` または `[]` ブロックだけを抽出してからパースする。例: `match(/\\{[\\s\\S]*\\}/)`',
    tags: ['llm', 'json', 'parsing'],
    applicability: { signals: ['llm', 'json.parse'] },
  },
  {
    title: 'セマフォによる即時退避 (Skip if Busy)',
    content:
      'リソース集約的な処理では、セマフォ取得に短いタイムアウトを設定し、競合時は「待機」ではなく「スキップ」して制御を戻すことで、システムのハングを回避する。',
    tags: ['concurrency', 'resource-management'],
    applicability: { signals: ['semaphore', 'lock', 'concurrency'] },
  },
  {
    title: '決定論的 ID による知識統合',
    content:
      'スラッグ化したエンティティ名 (`type/name`) を ID とすることで、異なるセッション間でも同じ概念を自動的にマッピング・統合できるようにする。`generateEntityId(type, name)` を使用。',
    tags: ['knowledge-graph', 'identity'],
    applicability: { signals: ['entity', 'id', 'slug'] },
  },
  {
    title: 'SQLite WAL モードの活用',
    content:
      'マルチプロセス環境では、DB 初期化時に必ず `PRAGMA journal_mode = WAL` を実行し、バックグラウンド処理がフロント（MCP）をブロックしないようにする。',
    tags: ['sqlite', 'database', 'concurrency'],
    applicability: { signals: ['sqlite', 'database', 'init'] },
  },
  {
    title: 'アトミックなタスク取得パターン',
    content:
      'ジョブキューの実装では、`SELECT` と `UPDATE` を単一トランザクション内で実行し、ワーカー間でのタスク奪い合いや二重実行を防止する。',
    tags: ['database', 'transaction', 'queue'],
    applicability: { signals: ['transaction', 'queue'] },
  },
  {
    title: '軽量 DI (Deps 引数) パターン',
    content:
      '複雑なフレームワークを導入せず、関数引数末尾の `deps` オブジェクトで依存を注入し、本番実装とテスト用モックの切り替えを容易にする。例: `function myFunc(arg, deps = { db: defaultDb })`',
    tags: ['design-pattern', 'testing', 'di'],
    applicability: { signals: ['deps', 'di'] },
  },
  {
    title: 'JSONB 包含検索によるメタデータ抽出',
    content:
      'ベクトル検索の事後フィルタリングとして、`@>` 演算子を用いたメタデータ検索を組み合わせ、属性ベースの精密な絞り込みを実現する。例: `where(sql`${table.metadata} @> \'{"kind":"guidance"}\'::jsonb`)`',
    tags: ['database', 'search', 'jsonb'],
    applicability: { signals: ['jsonb', 'filter', 'metadata'] },
  },
  {
    title: '自己修復型タスクマネジメント',
    content:
      'プロセスクラッシュに備え、一定時間 `running` のまま更新がないタスクを自動で `pending` にリセットするクリーンアップロジックを常駐させる。',
    tags: ['reliability', 'automation', 'recovery'],
    applicability: { signals: ['cleanup', 'stale', 'task'] },
  },
];

const RULES = [
  {
    title: '[命名規則] エンティティIDの生成',
    content:
      '全ての新エンティティ ID は `utils/entityId.ts` の `generateEntityId` を通じて生成し、UUID を直接生成してはならない。',
    tags: ['rule', 'naming', 'id'],
  },
  {
    title: '[外部連携] プロセス実行時のセキュリティ',
    content:
      '`child_process` でテキスト入力を扱う場合は、必ず引数リストの直前に `--` を挿入し、位置引数であることを明示しなければならない。',
    tags: ['rule', 'cli', 'security'],
  },
  {
    title: '[AI連携] リソース競合のハンドリング',
    content:
      'LLM サービスを呼び出す新機能は、必ず `withGlobalSemaphore` を使用し、同時実行数制限を遵守しなければならない。',
    tags: ['rule', 'ai', 'concurrency'],
  },
  {
    title: '[データ層] 状態遷移の不可分性',
    content:
      'タスクのステータス変更（例：`pending` -> `running`）を伴う DB 操作は、例外なく単一のトランザクション内で実行しなければならない。',
    tags: ['rule', 'database', 'transaction'],
  },
  {
    title: '[エラー処理] 構造化エラーの返却',
    content:
      'ユーザーまたは MCP クライアントに通知する可能性のあるエラーは、`GnosisError` を継承し、適切な `statusHint` を付与しなければならない。',
    tags: ['rule', 'error-handling'],
  },
  {
    title: '[設定管理] 外部変数の抽象化',
    content:
      '`process.env` を各ファイルで直接参照することを禁止する。すべての設定は `config.ts` を経由しなければならない。',
    tags: ['rule', 'config'],
  },
];

async function main() {
  console.log('Starting manual guidance synchronization...');

  for (const skill of SKILLS) {
    console.log(`Syncing skill: ${skill.title}`);
    await saveGuidance({
      ...skill,
      guidanceType: 'skill',
      scope: 'on_demand',
      priority: 80,
    });
  }

  for (const rule of RULES) {
    console.log(`Syncing rule: ${rule.title}`);
    await saveGuidance({
      ...rule,
      guidanceType: 'rule',
      scope: 'always',
      priority: 100,
    });
  }

  console.log('Synchronization completed successfully.');
  await closeDbPool();
}

main().catch((err) => {
  console.error('Synchronization failed:', err);
  process.exit(1);
});
