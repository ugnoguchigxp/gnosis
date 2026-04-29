import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities } from '../db/schema.js';
import { isGnosisError } from '../domain/errors.js';
import { buildToolSnapshotForDoctor } from '../services/agentFirst.js';
import { getExposedToolEntries } from './tools/index.js';

// ---------------------------------------------------------------------------
// Process Metadata
// ---------------------------------------------------------------------------
if (import.meta.main) {
  console.error('[Error] src/mcp/server.ts cannot be run directly.');
  console.error('[Error] Please use src/index.ts as the entry point.');
  process.exit(1);
} else {
  // Logic-only title (may be overwritten by index.ts)
  process.title = 'gnosis-mcp-logic';
}

// ---------------------------------------------------------------------------
// scope:'always' エンティティのキャッシュ（TTL: 5分）
// ---------------------------------------------------------------------------
let alwaysCache: { content: string; expiresAt: number } | null = null;
const ALWAYS_CACHE_TTL_MS = 5 * 60 * 1000;
const FULL_ALWAYS_CONTEXT_TOOLS = new Set(['initial_instructions']);

export function shouldInjectAlwaysContext(toolName: string): boolean {
  return FULL_ALWAYS_CONTEXT_TOOLS.has(toolName);
}

async function getAlwaysContext(): Promise<string> {
  const now = Date.now();
  if (alwaysCache && alwaysCache.expiresAt > now) return alwaysCache.content;

  try {
    const rows = await db
      .select({ name: entities.name, type: entities.type, description: entities.description })
      .from(entities)
      .where(eq(entities.scope, 'always'));

    if (rows.length === 0) {
      alwaysCache = { content: '', expiresAt: now + ALWAYS_CACHE_TTL_MS };
      return '';
    }

    const lines = rows.map((r) => `[${r.type}] ${r.name}: ${r.description ?? ''}`);
    const content = `## 常時適用ルール・制約 (scope:always)\n${lines.join('\n')}\n---`;
    alwaysCache = { content, expiresAt: now + ALWAYS_CACHE_TTL_MS };
    return content;
  } catch {
    return '';
  }
}

export const server = new Server(
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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getExposedToolEntries().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
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
        content: [{ type: 'text', text: alwaysCtx }, ...result.content],
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
});
