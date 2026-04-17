import { recallExperienceLessons } from '../../experience.js';
import { getGuidanceContext } from '../../guidance/search.js';
import { searchKnowledgeClaims } from '../../knowledge.js';
import { searchMemory } from '../../memory.js';
import type { ReviewerToolEntry } from './types.js';

export const recallLessonsToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'recall_lessons',
    description: '過去のコードレビューや開発での失敗・教訓を検索します。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: '現在のコード変更や課題に関連するキーワード' },
        limit: { type: 'integer', default: 5 },
      },
    },
  },
  async handler(args, ctx) {
    try {
      const lessons = await recallExperienceLessons(
        ctx.gnosisSessionId,
        String(args.query),
        Number(args.limit ?? 5),
      );
      if (lessons.length === 0) return 'No matching lessons found.';
      return JSON.stringify(lessons, null, 2);
    } catch (error) {
      return `[Error recalling lessons]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

export const searchMemoryToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'search_memory',
    description:
      'Gnosis の記憶（Vibe Memory）を検索します。関連する文脈や設計意図の確認に役立ちます。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: '検索クエリ' },
        limit: { type: 'integer', default: 5 },
      },
    },
  },
  async handler(args, ctx) {
    try {
      const results = await searchMemory(
        ctx.gnosisSessionId,
        String(args.query),
        Number(args.limit ?? 5),
      );
      if (results.length === 0) return 'No matching memory found.';
      return JSON.stringify(results, null, 2);
    } catch (error) {
      return `[Error searching memory]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

export const searchKnowledgeToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'search_knowledge',
    description: '検証済みの知識ベース（Knowledge Base）を検索します。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: '検索クエリ' },
        limit: { type: 'integer', default: 5 },
      },
    },
  },
  async handler(args, ctx) {
    try {
      const results = await searchKnowledgeClaims(String(args.query), Number(args.limit ?? 5));
      if (results.length === 0) return 'No matching knowledge found.';
      return JSON.stringify(results, null, 2);
    } catch (error) {
      return `[Error searching knowledge]: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  },
};

export const getGuidanceToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'get_guidance',
    description: '現在のコンテキストに関連するガイダンス（ルールやスキル）を取得します。',
    inputSchema: {
      type: 'object',
      required: ['context_query'],
      properties: {
        context_query: { type: 'string', description: '現在の状況や対象コードに関連するクエリ' },
      },
    },
  },
  async handler(args, ctx) {
    try {
      const guidance = await getGuidanceContext(String(args.context_query));
      return guidance || 'No relevant guidance found.';
    } catch (error) {
      return `[Error getting guidance]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
