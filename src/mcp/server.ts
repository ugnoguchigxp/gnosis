import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { saveMemory, searchMemory } from '../services/memory.js';
import {
  queryGraphContext,
  saveEntities,
  saveRelations,
  updateEntity,
  deleteRelation,
} from '../services/graph.js';

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

// Tools Definition Schema
const storeMemorySchema = z.object({
  sessionId: z.string().describe('セッションID (プロジェクトやコンテキストを分離する識別子)'),
  content: z.string().describe('記憶するテキスト内容'),
  metadata: z.record(z.unknown()).optional().describe('その他のメタデータ'),
  entities: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        name: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional()
    .describe('関連するエンティティ(抽出された場合)'),
  relations: z
    .array(
      z.object({
        sourceId: z.string(),
        targetId: z.string(),
        relationType: z.string(),
        weight: z.string().optional(),
      }),
    )
    .optional()
    .describe('エンティティ間の関係'),
});

const searchMemorySchema = z.object({
  sessionId: z.string().describe('検索対象のセッションID'),
  query: z.string().describe('検索クエリ'),
  limit: z.number().optional().default(5).describe('取得件数'),
});

const queryGraphSchema = z.object({
  entityId: z.string().describe('コンテキストを取得したいエンティティID'),
});

const updateGraphSchema = z.object({
  action: z.enum(['update_entity', 'delete_relation']).describe('実行する更新のタイプ'),
  entity: z
    .object({
      id: z.string(),
      type: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
    })
    .optional()
    .describe('エンティティ情報の更新時のみ使用'),
  relation: z
    .object({
      sourceId: z.string(),
      targetId: z.string(),
      relationType: z.string(),
    })
    .optional()
    .describe('リレーション削除時のみ使用'),
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'store_memory',
        description: 'Vibe Memory と Knowledge Graph に新しい記憶と構造化知識を保存します',
        inputSchema: zodToJsonSchema(storeMemorySchema),
      },
      {
        name: 'search_memory',
        description: 'Vibe Memory をセマンティック検索します',
        inputSchema: zodToJsonSchema(searchMemorySchema),
      },
      {
        name: 'query_graph',
        description: '対象エンティティのグラフ関連情報を取得します (Graph RAG)',
        inputSchema: zodToJsonSchema(queryGraphSchema),
      },
      {
        name: 'update_graph',
        description: 'グラフ内のエンティティや関係性を訂正・削除してナレッジを更新します',
        inputSchema: zodToJsonSchema(updateGraphSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'store_memory': {
        const input = storeMemorySchema.parse(args);

        // メモリ保存
        const memory = await saveMemory(input.sessionId, input.content, input.metadata);

        // グラフ保存
        if (input.entities?.length) await saveEntities(input.entities);
        if (input.relations?.length) await saveRelations(input.relations);

        return {
          content: [{ type: 'text', text: `Memory stored successfully with ID: ${memory.id}` }],
        };
      }

      case 'search_memory': {
        const { sessionId, query, limit } = searchMemorySchema.parse(args);
        const results = await searchMemory(sessionId, query, limit);

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }

      case 'query_graph': {
        const { entityId } = queryGraphSchema.parse(args);
        const context = await queryGraphContext(entityId);

        return {
          content: [{ type: 'text', text: JSON.stringify(context, null, 2) }],
        };
      }

      case 'update_graph': {
        const input = updateGraphSchema.parse(args);
        if (input.action === 'update_entity') {
          if (!input.entity?.id) throw new Error('entity.id is required for update_entity');
          await updateEntity(input.entity.id, input.entity);
          return {
            content: [{ type: 'text', text: `Entity ${input.entity.id} updated successfully` }],
          };
        }
        if (input.action === 'delete_relation') {
          if (!input.relation) throw new Error('relation info is required for delete_relation');
          await deleteRelation(
            input.relation.sourceId,
            input.relation.targetId,
            input.relation.relationType,
          );
          return {
            content: [
              {
                type: 'text',
                text: `Relation ${input.relation.relationType} deleted successfully`,
              },
            ],
          };
        }
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    // biome-ignore lint/suspicious/noExplicitAny: error checking
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error executing tool: ${error?.message || String(error)}` }],
      isError: true,
    };
  }
});
