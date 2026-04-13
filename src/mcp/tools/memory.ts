import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { db } from '../../db/index.js';
import { saveEntities, saveRelations } from '../../services/graph.js';
import { deleteMemory, saveMemory, searchMemory } from '../../services/memory.js';
import type { ToolEntry } from '../registry.js';

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
  filter: z.record(z.unknown()).optional().describe('メタデータのJSONフィルタ条件'),
});

const deleteMemorySchema = z.object({
  memoryId: z.string().describe('削除する Vibe Memory の ID'),
});

export const memoryTools: ToolEntry[] = [
  {
    name: 'store_memory',
    description: `汎用的な観察・知識・レビュー結果を Vibe Memory（ベクトル検索）と Knowledge Graph に保存します。
- コードレビューの指摘事項・改善提案を後で参照できるよう保存する
- 設計上の決定・トレードオフの記録
- バグの原因分析、調査結果のメモ
- 任意の自由形式の観察・知見の蓄積`,
    inputSchema: zodToJsonSchema(storeMemorySchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = storeMemorySchema.parse(args);
      const memory = await db.transaction(async (tx) => {
        const savedMemory = await saveMemory(input.sessionId, input.content, input.metadata, tx);
        if (input.entities?.length) await saveEntities(input.entities, tx);
        if (input.relations?.length) await saveRelations(input.relations, tx);
        return savedMemory;
      });
      return {
        content: [{ type: 'text', text: `Memory stored successfully with ID: ${memory.id}` }],
      };
    },
  },
  {
    name: 'search_memory',
    description: `保存済みの Vibe Memory をセマンティック（意味的類似度）で検索します。
メタデータフィルタと組み合わせたハイブリッド検索も可能です。`,
    inputSchema: zodToJsonSchema(searchMemorySchema) as Record<string, unknown>,
    handler: async (args) => {
      const { sessionId, query, limit, filter } = searchMemorySchema.parse(args);
      const results = await searchMemory(sessionId, query, limit, filter);
      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    },
  },
  {
    name: 'delete_memory',
    description: '特定の Vibe Memory を ID を指定して削除します（忘却操作）。',
    inputSchema: zodToJsonSchema(deleteMemorySchema) as Record<string, unknown>,
    handler: async (args) => {
      const { memoryId } = deleteMemorySchema.parse(args);
      await deleteMemory(memoryId);
      return {
        content: [{ type: 'text', text: `Memory ${memoryId} has been deleted successfully` }],
      };
    },
  },
];
