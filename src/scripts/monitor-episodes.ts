import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { entities, relations, vibeMemories } from '../db/schema.js';
import { consolidateEpisodes } from '../services/consolidation.js';

async function main() {
  const rawArgs = process.argv.slice(2);
  const strict = rawArgs.includes('--strict');
  const args = rawArgs.filter((arg) => arg !== '--strict');
  const command = args[0];

  if (strict && command !== 'consolidate') {
    throw new Error('--strict is supported only for consolidate');
  }

  if (command === 'list') {
    const eps = await db
      .select()
      .from(vibeMemories)
      .where(eq(vibeMemories.memoryType, 'episode'))
      .orderBy(desc(vibeMemories.createdAt));

    console.log(JSON.stringify(eps, null, 2));
    process.exit(0);
  } else if (command === 'delete') {
    const id = args[1]?.trim();
    if (!id) throw new Error('Missing episode ID');

    // 1. まずエピソードの存在確認とメタデータ（sourceIds）の取得を行う
    const episode = await db.query.vibeMemories.findFirst({
      where: eq(vibeMemories.id, id),
    });

    if (!episode) {
      console.error(JSON.stringify({ success: false, error: 'Episode not found', id }));
      process.exit(1);
    }

    const metadata = episode.metadata as { sourceIds?: string[] } | null;
    const { sourceIds } = metadata || {};
    const episodeEntityId = `episode/${episode.id}`;

    // 2. 関連するデータの物理削除をアトミックに行う (TRANSACTION)
    console.error(`Starting atomic physical cleanup for episode: ${id}`);

    try {
      await db.transaction(async (tx) => {
        // (a) ナレッジグラフ上のエンティティ削除 (プロキシおよび metadata 経由)
        await tx.delete(entities).where(eq(entities.id, episodeEntityId));
        await tx.delete(entities).where(sql`metadata->>'memoryId' = ${id}`);

        // (b) リレーションの削除
        await tx
          .delete(relations)
          .where(sql`source_id = ${episodeEntityId} OR target_id = ${episodeEntityId}`);

        // (c) 元になった生メモの物理削除
        if (Array.isArray(sourceIds) && sourceIds.length > 0) {
          await tx.delete(vibeMemories).where(inArray(vibeMemories.id, sourceIds));
          console.error(`Deleted ${sourceIds.length} raw memories.`);
        }

        // (d) エピソード記憶本体を最後に削除
        await tx.delete(vibeMemories).where(eq(vibeMemories.id, episode.id));
      });

      console.log(
        JSON.stringify({ success: true, id, message: 'Physical deletion completed successfully' }),
      );
      process.exit(0);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({ success: false, error: `Transaction failed: ${message}`, id }),
      );
      process.exit(1);
    }
  } else if (command === 'register') {
    // ユーザーからの入力を raw memory にして即座に登録（統合は別途実行）
    const content = args[1];
    if (!content) throw new Error('Missing content');

    const sessionId = `manual-reg-${Date.now()}`;

    // 1. Raw memory として登録
    console.error(`Registering raw memory for manual entry. content length: ${content.length}`);
    const [raw] = await db
      .insert(vibeMemories)
      .values({
        content,
        embedding: new Array(config.embeddingDimension).fill(0),
        memoryType: 'raw',
        sessionId,
        isSynthesized: false,
      })
      .returning();

    console.log(
      JSON.stringify({ success: true, rawId: raw.id, sessionId, message: 'Raw memory registered' }),
    );
    process.exit(0);
  } else if (command === 'consolidate') {
    // 指定されたセッション、または最新のセッションを統合してエピソード化
    const sessionId = args[1];
    if (!sessionId) throw new Error('Missing session ID for consolidation');

    console.error(`Starting consolidation for session: ${sessionId}`);
    const result = await consolidateEpisodes(sessionId, { minRawCount: 1 });

    if (result) {
      console.error(`Consolidation successful: ${result.episodeId}`);
      console.log(JSON.stringify({ success: true, ...result }));
      process.exit(0);
    } else {
      console.error('Consolidation result was null (skipped).');
      console.log(
        JSON.stringify({
          success: false,
          error: 'Consolidation skipped (not enough data or already processed)',
          strict,
        }),
      );
      process.exit(strict ? 1 : 0);
    }
  } else {
    console.error(
      'Unknown command. Use: list, delete <id>, register <content>, consolidate <sessionId> [--strict]',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
