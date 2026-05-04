import { type EntityKnowledgeSearchType, searchEntityKnowledge } from '../../entityKnowledge.js';

export type KnowledgeSearchArgs = {
  query: string;
  type: EntityKnowledgeSearchType;
  limit?: number;
};

type Degraded = { code: string; message: string };

export async function runKnowledgeSearch(
  args: KnowledgeSearchArgs,
): Promise<Record<string, unknown>> {
  try {
    const rows = await searchEntityKnowledge({
      query: args.query,
      type: args.type,
      limit: args.limit ?? 5,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        content: row.content,
        source: 'entities',
        score: row.score,
        metadata: row.metadata,
      })),
    };
  } catch (error) {
    return {
      items: [],
      degraded: {
        code: 'ENTITY_SEARCH_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      } satisfies Degraded,
    };
  }
}
