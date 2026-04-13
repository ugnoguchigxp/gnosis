import { desc, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { vibeMemories } from '../../db/schema.js';
import { generateEmbedding } from '../memory.js';

export async function getAlwaysOnGuidance(
  limit = config.guidance.alwaysLimit,
  sessionId = config.guidance.sessionId,
) {
  const results = await db
    .select({
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
      priority: sql<number>`(${vibeMemories.metadata}->>'priority')::int`,
    })
    .from(vibeMemories)
    .where(
      sql`${vibeMemories.sessionId} = ${sessionId} AND ${vibeMemories.metadata} @> ${JSON.stringify(
        {
          kind: 'guidance',
          scope: 'always',
        },
      )}::jsonb`,
    )
    .orderBy((fields) => desc(fields.priority))
    .limit(limit);

  return results;
}

export async function getOnDemandGuidance(
  query: string,
  limit = config.guidance.onDemandLimit,
  minSimilarity = config.guidance.minSimilarity,
  sessionId = config.guidance.sessionId,
) {
  const embedding = await generateEmbedding(query);
  const embeddingStr = JSON.stringify(embedding);
  const similarity = sql<number>`1 - (${vibeMemories.embedding} <=> ${embeddingStr}::vector)`;

  const results = await db
    .select({
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
      similarity,
    })
    .from(vibeMemories)
    .where(
      sql`${vibeMemories.sessionId} = ${sessionId} AND ${vibeMemories.metadata} @> ${JSON.stringify(
        {
          kind: 'guidance',
          scope: 'on_demand',
        },
      )}::jsonb AND ${similarity} >= ${minSimilarity}`,
    )
    .orderBy((fields) => desc(fields.similarity))
    .limit(limit);

  return results;
}

export async function getGuidanceContext(query: string): Promise<string> {
  const [always, onDemand] = await Promise.all([
    getAlwaysOnGuidance().catch(() => []),
    getOnDemandGuidance(query).catch(() => []),
  ]);

  if (always.length === 0 && onDemand.length === 0) {
    return '';
  }

  const sections: string[] = [];

  if (always.length > 0) {
    sections.push('## Core Safety & Architecture Rules (Always-on)');
    sections.push(always.map((g) => g.content).join('\n---\n'));
  }

  if (onDemand.length > 0) {
    sections.push('## Relevant Skills & Guidelines (On-demand)');
    sections.push(onDemand.map((g) => g.content).join('\n---\n'));
  }

  return sections.join('\n\n');
}
