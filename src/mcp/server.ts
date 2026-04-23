import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities } from '../db/schema.js';
import { isGnosisError } from '../domain/errors.js';
import { toolEntries } from './tools/index.js';

// ---------------------------------------------------------------------------
// Process Metadata
// ---------------------------------------------------------------------------
if (import.meta.main) {
  process.title = 'gnosis-mcp-standalone-warn';
  console.error('[Warning] src/mcp/server.ts is being run directly.');
  console.error(
    '[Warning] Please use src/index.ts as the entry point for proper signal handling and cleanup.',
  );
} else {
  // Logic-only title (may be overwritten by index.ts)
  process.title = 'gnosis-mcp-logic';
}

// ---------------------------------------------------------------------------
// scope:'always' エンティティのキャッシュ（TTL: 5分）
// ---------------------------------------------------------------------------
let alwaysCache: { content: string; expiresAt: number } | null = null;
const ALWAYS_CACHE_TTL_MS = 5 * 60 * 1000;

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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolEntries.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const entry = toolEntries.find((t) => t.name === name);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await entry.handler(args);
    // scope:'always' エンティティを各ツール応答の先頭に注入
    const alwaysCtx = await getAlwaysContext();
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
