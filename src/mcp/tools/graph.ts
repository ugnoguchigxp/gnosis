import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { buildCommunities } from '../../services/community.js';
import {
  deleteRelation,
  digestTextIntelligence,
  findEntityById,
  findPathBetweenEntities,
  queryGraphContext,
  searchEntityByQuery,
  updateEntity,
} from '../../services/graph.js';
import type { ToolEntry } from '../registry.js';

const queryGraphSchema = z.object({
  query: z
    .string()
    .describe('起点とするエンティティを探すための検索クエリ(IDあるいは名前・説明など)'),
});

const digestTextSchema = z.object({
  text: z.string().describe('既存の知識グラフとの関連を調査したいテキスト'),
  limit: z.number().optional().default(5).describe('提案するエンティティの最大数'),
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

const findPathSchema = z.object({
  queryA: z.string().describe('起点エンティティ（ID、名前、または説明文）'),
  queryB: z.string().describe('終点エンティティ（ID、名前、または説明文）'),
});

export const graphTools: ToolEntry[] = [
  {
    name: 'query_graph',
    description: `Knowledge Graph からエンティティとその関連情報を取得します（Graph RAG）。
指定エンティティを起点に最大2ホップ先の関連ノード・エッジを一括取得します。`,
    inputSchema: zodToJsonSchema(queryGraphSchema) as Record<string, unknown>,
    handler: async (args) => {
      const { query } = queryGraphSchema.parse(args);
      const exactMatchId = await findEntityById(query);
      const entityId = exactMatchId || (await searchEntityByQuery(query));
      if (!entityId) {
        return {
          content: [{ type: 'text', text: `No entity found matching query: ${query}` }],
        };
      }
      const context = await queryGraphContext(entityId);
      return {
        content: [{ type: 'text', text: JSON.stringify(context, null, 2) }],
      };
    },
  },
  {
    name: 'digest_text',
    description:
      'テキスト中のキーワードに関連する既存グラフエンティティを検索し、候補を提案します。',
    inputSchema: zodToJsonSchema(digestTextSchema) as Record<string, unknown>,
    handler: async (args) => {
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
    },
  },
  {
    name: 'update_graph',
    description:
      'グラフ内のエンティティ情報を修正、またはリレーションを削除してナレッジを正確に保ちます。',
    inputSchema: zodToJsonSchema(updateGraphSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = updateGraphSchema.parse(args);
      if (input.action === 'update_entity') {
        if (!input.entity?.id) throw new Error('entity.id is required for update_entity');
        await updateEntity(input.entity.id, input.entity);
        return {
          content: [{ type: 'text', text: `Entity ${input.entity.id} updated successfully.` }],
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
              text: `Relation ${input.relation.relationType} deleted successfully.`,
            },
          ],
        };
      }
      throw new Error(`Unsupported action: ${input.action}`);
    },
  },
  {
    name: 'find_path',
    description: '2つのエンティティ間の最短経路（つながり）を Knowledge Graph から探索します。',
    inputSchema: zodToJsonSchema(findPathSchema) as Record<string, unknown>,
    handler: async (args) => {
      const { queryA, queryB } = findPathSchema.parse(args);
      const result = await findPathBetweenEntities(queryA, queryB);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  },
  {
    name: 'build_communities',
    description: 'グラフ全体を分析し、知識の塊（コミュニティ）を検出・要約します。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args) => {
      const result = await buildCommunities();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  },
];
