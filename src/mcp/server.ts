import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities } from '../db/schema.js';
import { isGnosisError } from '../domain/errors.js';
import { buildToolSnapshotForDoctor } from '../services/agentFirst.js';
import type { McpHostService, McpHostTool } from './hostProtocol.js';
import type { ToolResult } from './registry.js';
import { getExposedToolEntries } from './tools/index.js';

// ---------------------------------------------------------------------------
// scope:'always' エンティティのキャッシュ（TTL: 5分）
// ---------------------------------------------------------------------------
let alwaysCache: { content: string; expiresAt: number } | null = null;
const ALWAYS_CACHE_TTL_MS = 5 * 60 * 1000;
const FULL_ALWAYS_CONTEXT_TOOLS = new Set(['initial_instructions']);

type AlwaysContextRow = {
  name: string;
  type: string;
  description: string | null;
  metadata: unknown;
};

const BOOTSTRAP_OPERATION_RULES = [
  '作業完了前にセルフレビューし、この repo に合う verify gate を実行する。',
  'Git 操作と commit/PR はユーザー指示または確認後に行う。',
];

const BOOTSTRAP_TOOL_USAGE = [
  '`initial_instructions`: Gnosis の現行ツール方針が不明な時だけ最初に使う。毎タスクの前置きにはしない。',
  '`agentic_search`: 非自明な実装・レビュー・調査で、過去知識や成功/失敗例が判断を変え得る時に使う主導線。`userRequest` に goal、files、changeTypes、intent を含める。',
  '`search_knowledge`: raw候補、スコア、近い語句を直接確認したい時だけ使う。通常回答や方針判断は `agentic_search` を優先する。',
  '`review_task`: コード差分、ドキュメント、計画、仕様、設計をレビューする時に使う。根拠必須なら `knowledgePolicy: "required"` を検討する。',
  '`record_task_note`: verify 後、次回も使える rule / lesson / procedure / decision が得られた時だけ保存する。作業ログ丸ごとは保存しない。',
  '`doctor`: tool visibility、DB、MCP host、metadata、timeout/Transport closed など runtime が怪しい時、または復旧後の確認に使う。',
  '`memory_search` / `memory_fetch`: context 圧縮後に raw memory の具体的根拠が必要な時だけ使う。まず search で候補を見て、必要分だけ fetch する。',
];

export function shouldInjectAlwaysContext(toolName: string): boolean {
  return FULL_ALWAYS_CONTEXT_TOOLS.has(toolName);
}

function normalizeRuleKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`*_#>\-:：/／（）()。、，,\s]+/g, '');
}

function metadataContent(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object') return '';
  const content = (metadata as Record<string, unknown>).content;
  return typeof content === 'string' ? content.trim() : '';
}

function compactFallbackRule(row: AlwaysContextRow, rawText: string): string {
  const lines = rawText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/^#+\s*/, '')
        .replace(/^[-*]\s*/, '')
        .replace(/\*\*/g, '')
        .trim(),
    )
    .filter((line) => line.length > 0 && !line.endsWith(':'));
  const firstLine = lines[0] ?? row.name;
  const text = firstLine.replace(/\s+/g, ' ').trim();
  return text.endsWith('。') ? text : `${text}。`;
}

function compactAlwaysRule(row: AlwaysContextRow): string {
  const rawText = metadataContent(row.metadata) || row.description || row.name;
  const haystack = `${row.name}\n${rawText}`;

  if (/\.envファイル変更|\.env/.test(haystack)) {
    return '明示的な許可なく `.env` ファイルを変更しない。';
  }

  if (/pnpm build\/test|ESLint|型チェック|コードレビュー|既存共通部品/.test(haystack)) {
    return 'コード変更では型チェック、lint、test/build など該当する verify gate を実行し、既存共通部品を優先する。docs-only 変更では不要な build/lint を増やさない。';
  }

  if (/verifyコマンド|品質チェック|tsc|vitest|vite build|biome check/.test(haystack)) {
    return 'タスク完了時は、この repo の実態に合う verify コマンドで品質を確認する。';
  }

  if (
    /サーバー独自起動|認証バイパス|Git操作|コミット・PR|useRef|useEffect|useQueryClient|invalidateQueries/.test(
      haystack,
    )
  ) {
    return '独自サーバー起動、認証バイパス実装、React hook の無限ループを避ける。Git 操作と commit/PR はユーザー指示または確認後に行い、API mutation は query invalidation まで含める。';
  }

  if (/KISS|YAGNI|DRY|単一責任|関心分離|依存性逆転|合成|最小驚愕/.test(haystack)) {
    return '設計は KISS/YAGNI、DRY、単一責任、関心分離、依存性逆転、合成優先、最小驚愕を基本にする。';
  }

  return compactFallbackRule(row, rawText);
}

export function formatAlwaysContextRows(rows: AlwaysContextRow[]): string {
  const rules: string[] = [];
  const seen = new Set<string>();

  for (const rule of BOOTSTRAP_OPERATION_RULES) {
    const key = normalizeRuleKey(rule);
    seen.add(key);
    rules.push(rule);
  }

  for (const row of rows) {
    const rule = compactAlwaysRule(row);
    const key = normalizeRuleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }

  return [
    '## 常用ルール',
    '',
    rules.map((rule) => `- ${rule}`).join('\n'),
    '',
    '## MCPツール種別',
    '',
    BOOTSTRAP_TOOL_USAGE.map((rule) => `- ${rule}`).join('\n'),
  ].join('\n');
}

async function getAlwaysContext(): Promise<string> {
  const now = Date.now();
  if (alwaysCache && alwaysCache.expiresAt > now) return alwaysCache.content;

  try {
    const rows = await db
      .select({
        name: entities.name,
        type: entities.type,
        description: entities.description,
        metadata: entities.metadata,
      })
      .from(entities)
      .where(eq(entities.scope, 'always'));

    const content = formatAlwaysContextRows(rows);
    alwaysCache = { content, expiresAt: now + ALWAYS_CACHE_TTL_MS };
    return content;
  } catch {
    return formatAlwaysContextRows([]);
  }
}

(globalThis as Record<string, unknown>).__GNOSIS_TOOL_SNAPSHOT = buildToolSnapshotForDoctor(
  getExposedToolEntries().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
);
(globalThis as Record<string, unknown>).__GNOSIS_EXPOSED_TOOL_NAMES = getExposedToolEntries().map(
  (tool) => tool.name,
);

export function listGnosisTools(): McpHostTool[] {
  return getExposedToolEntries().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export async function callGnosisTool(name: string, args: unknown): Promise<ToolResult> {
  const entry = getExposedToolEntries().find((t) => t.name === name);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await entry.handler(args);
    // scope:'always' is session-level context. Do not reattach it to task-specific retrieval output.
    const alwaysCtx = shouldInjectAlwaysContext(name) ? await getAlwaysContext() : '';
    if (alwaysCtx && result.content && Array.isArray(result.content)) {
      return {
        ...result,
        content: [{ type: 'text', text: alwaysCtx }],
      };
    }
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = isGnosisError(error) ? error.code : 'INTERNAL';
    return {
      content: [{ type: 'text', text: `[${code}] ${message}` }],
      isError: true,
    };
  }
}

export function createGnosisMcpService(): McpHostService {
  return {
    name: 'gnosis-memory-kg',
    version: '0.1.0',
    listTools: listGnosisTools,
    callTool: callGnosisTool,
  };
}

export function createGnosisMcpServer(): Server {
  const sdkServer = new Server(
    {
      name: 'gnosis-memory-kg',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  sdkServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listGnosisTools() as Tool[],
  }));

  sdkServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callGnosisTool(name, args);
  });

  return sdkServer;
}

export const server = createGnosisMcpServer();

if (import.meta.main) {
  console.error('[Error] src/mcp/server.ts cannot be run directly.');
  console.error('[Error] Please use src/index.ts as the entry point.');
  process.exit(1);
}
