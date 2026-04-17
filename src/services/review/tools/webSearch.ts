import type { ReviewerToolEntry } from './types.js';

export const webSearchToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'web_search',
    description: 'Web 検索を実行して情報を取得します。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: '検索クエリ' },
        limit: { type: 'integer', default: 5 },
      },
    },
  },
  async handler(_args, ctx) {
    if (ctx.webSearchFn) {
      try {
        const results = await ctx.webSearchFn(String(_args.query), Number(_args.limit ?? 5));
        return results.join('\n');
      } catch (error) {
        return `[Web search failed]: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    return '[System]: Web search provider is not configured. External information cannot be retrieved at this time.';
  },
};
