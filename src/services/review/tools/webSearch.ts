import { runBraveSearch } from '../../agenticSearch/tools/braveSearch.js';
import { runFetch } from '../../agenticSearch/tools/fetch.js';
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

export const braveSearchToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'brave_search',
    description: 'Brave Search API で外部Web検索結果を取得します。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: '検索クエリ' },
        count: { type: 'integer', default: 5 },
      },
    },
  },
  async handler(args) {
    return JSON.stringify(
      await runBraveSearch({
        query: String(args.query ?? ''),
        count: Number(args.count ?? 5),
      }),
      null,
      2,
    );
  },
};

export const fetchToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'fetch',
    description: 'URLの本文テキストを取得します。',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: '取得対象URL' },
      },
    },
  },
  async handler(args) {
    return JSON.stringify(
      await runFetch({
        url: String(args.url ?? ''),
      }),
      null,
      2,
    );
  },
};
