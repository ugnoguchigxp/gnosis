import { sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { vibeMemories } from '../../db/schema.js';
import type { GuidanceScope, GuidanceType } from '../../domain/schemas.js';
import { sha256 } from '../../utils/crypto.js';
import { generateEmbedding } from '../memory.js';
import { uniqueStrings } from './chunking.js';
import type { GuidanceMemoryRow } from './types.js';

type SaveGuidanceDependencies = {
  generateEmbedding: (text: string) => Promise<number[]>;
  now: () => Date;
  database: Pick<typeof db, 'transaction'>;
};

export async function saveGuidance(
  input: {
    title: string;
    content: string;
    guidanceType: GuidanceType;
    scope: GuidanceScope;
    priority: number;
    tags?: string[];
    archiveKey?: string;
    sessionId?: string;
  },
  deps: Partial<SaveGuidanceDependencies> = {},
): Promise<{ id: string; archiveKey: string }> {
  const resolvedDeps = {
    generateEmbedding: deps.generateEmbedding ?? generateEmbedding,
    now: deps.now ?? (() => new Date()),
    database: deps.database ?? db,
  };

  const sessionId = input.sessionId ?? config.guidance.sessionId;
  const now = resolvedDeps.now();
  const archiveKey = input.archiveKey ?? `manual:${sha256(input.title.toLowerCase())}`;
  const tags = uniqueStrings([...(input.tags ?? []), 'manual-entry']);

  const embedding = await resolvedDeps.generateEmbedding(input.content);
  const contentHash = sha256(input.content);
  const dedupeKey = sha256(`manual:${archiveKey}:${contentHash}:${input.scope}`);

  const metadata = {
    kind: 'guidance',
    guidanceType: input.guidanceType,
    scope: input.scope,
    priority: input.priority,
    title: input.title,
    tags,
    archiveKey,
    importedAt: now.toISOString(),
  };

  const row: GuidanceMemoryRow = {
    sessionId,
    content: input.content,
    embedding,
    dedupeKey,
    metadata,
  };

  await resolvedDeps.database.transaction(async (tx) => {
    await tx
      .delete(vibeMemories)
      .where(
        sql`${vibeMemories.sessionId} = ${sessionId} AND ${
          vibeMemories.metadata
        } @> ${JSON.stringify({ kind: 'guidance', archiveKey })}::jsonb`,
      );
    await tx.insert(vibeMemories).values(row);
  });

  return { id: dedupeKey, archiveKey };
}
