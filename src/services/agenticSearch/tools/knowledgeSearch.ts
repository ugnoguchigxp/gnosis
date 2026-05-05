import {
  type EntityKnowledgeSearchType,
  searchEntityKnowledgeDetailed,
} from '../../entityKnowledge.js';

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
    const { results: rows, telemetry } = await searchEntityKnowledgeDetailed({
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
        retrievalSource: row.source,
        matchSources: row.matchSources,
        sourceScores: row.sourceScores,
        metadata: row.metadata,
      })),
      retrieval: telemetry,
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
