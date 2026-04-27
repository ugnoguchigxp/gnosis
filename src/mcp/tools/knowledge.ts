import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { findEntityById, queryGraphContext, searchEntityByQuery } from '../../services/graph.js';
import { getKnowledgeByTopic, searchKnowledgeClaims } from '../../services/knowledge.js';
import { searchMemory } from '../../services/memory.js';
import type { ToolEntry } from '../registry.js';

const searchKnowledgeSchema = z.object({
  query: z.string().describe('検索クエリ'),
  limit: z.number().int().positive().optional().default(5).describe('取得件数'),
});

const getKnowledgeSchema = z.object({
  topic: z.string().describe('詳細を取得したいトピック名'),
});

const searchUnifiedSchema = z.object({
  query: z.string().describe('検索クエリ'),
  mode: z.enum(['fts', 'kg', 'semantic']).describe('検索モード'),
  limit: z.number().int().positive().optional().default(5).describe('取得件数'),
  sessionId: z
    .string()
    .optional()
    .describe('semantic モード使用時のセッションID (デフォルト: gnosis)'),
});

export const knowledgeTools: ToolEntry[] = [
  {
    name: 'search_knowledge_legacy',
    description: `Legacy API: knowFlow が蓄積した構造化知識（knowledge_claims）を全文検索します。
新しい検索は search_knowledge を使用してください。`,
    inputSchema: zodToJsonSchema(searchKnowledgeSchema) as Record<string, unknown>,
    handler: async (args) => {
      const { query, limit } = searchKnowledgeSchema.parse(args);
      const results = await searchKnowledgeClaims(query, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    },
  },
  {
    name: 'get_knowledge',
    description:
      '特定のトピックについて、knowFlow が収集・検証した詳細な知識（クレーム、関連トピック、情報源）をすべて取得します。',
    inputSchema: zodToJsonSchema(getKnowledgeSchema) as Record<string, unknown>,
    handler: async (args) => {
      const { topic } = getKnowledgeSchema.parse(args);
      const result = await getKnowledgeByTopic(topic);
      return {
        content: [
          {
            type: 'text',
            text: result
              ? JSON.stringify(result, null, 2)
              : `No detailed knowledge found for topic: ${topic}`,
          },
        ],
      };
    },
  },
  {
    name: 'search_unified',
    description: `目的や対象に応じた最適な手法（全文検索・グラフ・意味検索）を選択して検索を実行します。
- fts: knowFlow が蓄積した検証済み知識の全文検索
- kg: ナレッジグラフ内のエンティティとそのつながりの探索
- semantic: 保存済みの記憶（Vibe Memory）の意味的類似度検索`,
    inputSchema: zodToJsonSchema(searchUnifiedSchema) as Record<string, unknown>,
    handler: async (args) => {
      const { query, mode, limit, sessionId } = searchUnifiedSchema.parse(args);

      if (mode === 'fts') {
        const results = await searchKnowledgeClaims(query, limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }

      if (mode === 'kg') {
        const exactMatchId = await findEntityById(query);
        const entityId = exactMatchId || (await searchEntityByQuery(query));
        if (!entityId) {
          return {
            content: [{ type: 'text', text: `No entity found in graph matching query: ${query}` }],
          };
        }
        const context = await queryGraphContext(entityId);
        return {
          content: [{ type: 'text', text: JSON.stringify(context, null, 2) }],
        };
      }

      if (mode === 'semantic') {
        const results = await searchMemory(sessionId || 'gnosis', query, limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }

      throw new Error(`Unsupported search mode: ${mode}`);
    },
  },
];
