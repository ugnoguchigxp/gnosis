import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { db } from '../db/index.js';
import { buildCommunities } from '../services/community.js';
import { recallExperienceLessons, saveExperience } from '../services/experience.js';
import {
  deleteRelation,
  digestTextIntelligence,
  findEntityById,
  findPathBetweenEntities,
  queryGraphContext,
  saveEntities,
  saveRelations,
  searchEntityByQuery,
  updateEntity,
} from '../services/graph.js';
import { deleteMemory, saveMemory, searchMemory } from '../services/memory.js';
import { syncAllAgentLogs } from '../services/sync.js';
import { synthesizeKnowledge } from '../services/synthesis.js';

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
        weight: z.union([z.number(), z.string()]).optional(),
      }),
    )
    .optional()
    .describe('エンティティ間の関係'),
});

const searchMemorySchema = z.object({
  sessionId: z.string().describe('検索対象のセッションID'),
  query: z.string().describe('検索クエリ'),
  limit: z.number().optional().default(5).describe('取得件数'),
  filter: z.record(z.any()).optional().describe('メタデータのJSONフィルタ条件'),
});

const queryGraphSchema = z.object({
  query: z
    .string()
    .describe('起点とするエンティティを探すための検索クエリ(IDあるいは名前・説明など)'),
});

const digestTextSchema = z.object({
  text: z.string().describe('既存の知識グラフとの関連を調査したいテキスト'),
  limit: z.number().optional().default(5).describe('提案するエンティティの最大数'),
});

const deleteMemorySchema = z.object({
  memoryId: z.string().describe('削除する Vibe Memory の ID'),
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

const recordExperienceSchema = z.object({
  sessionId: z.string().describe('セッションID'),
  scenarioId: z.string().describe('シナリオID (e.g., smoke-001)'),
  attempt: z.number().int().positive().describe('試行回数'),
  type: z.enum(['failure', 'success']).describe('イベントのタイプ (failure or success)'),
  content: z.string().describe('イベントの内容 (失敗メッセージや成功パッチの説明)'),
  failureType: z.string().optional().describe('失敗のタイプ (e.g., RISK_BLOCKING)'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe('追加のメタデータ (riskFindings, applyRejects, patchDigest など)'),
});

const recallLessonsSchema = z.object({
  sessionId: z.string().describe('検索対象のセッションID'),
  query: z.string().describe('現在の失敗状況やエラーメッセージ'),
  limit: z.number().int().positive().optional().default(5).describe('取得件数'),
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
        name: 'digest_text',
        description:
          'テキスト内のキーワードに関連する既存のエンティティをグラフから探し出し提案します',
        inputSchema: zodToJsonSchema(digestTextSchema),
      },
      {
        name: 'delete_memory',
        description: '特定の Vibe Memory を削除します',
        inputSchema: zodToJsonSchema(deleteMemorySchema),
      },
      {
        name: 'build_communities',
        description:
          'グラフ全体を分析し、知識の塊（コミュニティ）を生成・要約します（計算負荷が高いツールです）',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'sync_agent_logs',
        description: 'Claude Code や Antigravity の会話履歴から自動的にナレッジを同期します',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'update_graph',
        description: 'グラフ内のエンティティや関係性を訂正・削除してナレッジを更新します',
        inputSchema: zodToJsonSchema(updateGraphSchema),
      },
      {
        name: 'find_path',
        description: '2つのエンティティ間のつながり（最短経路）を探索します',
        inputSchema: zodToJsonSchema(
          z.object({
            queryA: z.string().describe('起点A'),
            queryB: z.string().describe('終点B'),
          }),
        ),
      },
      {
        name: 'reflect_on_memories',
        description: '未処理のメモリを分析し、知識グラフへ自動統合（自己省察）します',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'record_experience',
        description: '失敗または成功イベントを構造化された教訓として記録します',
        inputSchema: zodToJsonSchema(recordExperienceSchema),
      },
      {
        name: 'recall_lessons',
        description: '類似する失敗事例から解決策や教訓を検索します',
        inputSchema: zodToJsonSchema(recallLessonsSchema),
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

        const memory = await db.transaction(async (tx) => {
          // メモリ保存
          const savedMemory = await saveMemory(input.sessionId, input.content, input.metadata, tx);

          // グラフ保存
          if (input.entities?.length) await saveEntities(input.entities, tx);
          if (input.relations?.length) await saveRelations(input.relations, tx);
          return savedMemory;
        });

        return {
          content: [{ type: 'text', text: `Memory stored successfully with ID: ${memory.id}` }],
        };
      }

      case 'search_memory': {
        const { sessionId, query, limit, filter } = searchMemorySchema.parse(args);
        const results = await searchMemory(sessionId, query, limit, filter);

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }

      case 'delete_memory': {
        const { memoryId } = deleteMemorySchema.parse(args);
        await deleteMemory(memoryId);

        return {
          content: [{ type: 'text', text: `Memory ${memoryId} has been deleted successfully` }],
        };
      }

      case 'query_graph': {
        const { query } = queryGraphSchema.parse(args);
        const exactMatchId = await findEntityById(query);
        const entityId = exactMatchId || (await searchEntityByQuery(query));
        if (!entityId) {
          return {
            content: [{ type: 'text', text: `No entity found matching query: ${query}` }],
          };
        }

        const context = await queryGraphContext(entityId); // Default depth is 2, max 20 nodes

        return {
          content: [{ type: 'text', text: JSON.stringify(context, null, 2) }],
        };
      }

      case 'digest_text': {
        const { text, limit } = digestTextSchema.parse(args);
        const results = await digestTextIntelligence(text, limit);

        return {
          content: [
            {
              type: 'text',
              text: 'LLM has extracted the following entities and found potential matches in the existing graph:',
            },
            { type: 'text', text: JSON.stringify(results, null, 2) },
          ],
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
        throw new Error(`Unsupported action: ${input.action}`);
      }

      case 'build_communities': {
        const result = await buildCommunities();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'sync_agent_logs': {
        const result = await syncAllAgentLogs();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'find_path': {
        const { queryA, queryB } = z.object({ queryA: z.string(), queryB: z.string() }).parse(args);
        const result = await findPathBetweenEntities(queryA, queryB);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'reflect_on_memories': {
        const result = await synthesizeKnowledge();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'record_experience': {
        const input = recordExperienceSchema.parse(args);
        const experience = await saveExperience(input);
        return {
          content: [
            {
              type: 'text',
              text: `Experience recorded successfully with ID: ${experience.id}`,
            },
          ],
        };
      }

      case 'recall_lessons': {
        const { sessionId, query, limit } = recallLessonsSchema.parse(args);
        const results = await recallExperienceLessons(sessionId, query, limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
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
