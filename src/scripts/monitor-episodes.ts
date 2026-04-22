import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { entities, relations, vibeMemories } from '../db/schema.js';
import { consolidateEpisodes } from '../services/consolidation.js';
import { createRunLogger } from '../services/knowflow/ops/runLog.js';

async function main() {
  const rawArgs = process.argv.slice(2);
  const strict = rawArgs.includes('--strict');
  const verbose = rawArgs.includes('--verbose');
  const runIdArg = rawArgs.find((arg) => arg.startsWith('--run-id='));
  const runId = runIdArg ? runIdArg.split('=')[1] : undefined;

  const args = rawArgs.filter(
    (arg) => arg !== '--strict' && arg !== '--verbose' && !arg.startsWith('--run-id='),
  );
  const command = args[0];

  const runLogger = await createRunLogger({ runId });
  const logger = runLogger.createStructuredLogger({ verbose });

  if (strict && command !== 'consolidate') {
    throw new Error('--strict is supported only for consolidate');
  }

  try {
    logger({ event: 'cli.start', command, args, strict, verbose });

    if (command === 'list') {
      const eps = await db
        .select()
        .from(vibeMemories)
        .where(eq(vibeMemories.memoryType, 'episode'))
        .orderBy(desc(vibeMemories.createdAt));

      process.stdout.write(`${JSON.stringify(eps, null, 2)}\n`);
      process.exit(0);
    } else if (command === 'delete') {
      const id = args[1]?.trim();
      if (!id) throw new Error('Missing episode ID');

      // 1. まずエピソードの存在確認とメタデータ（sourceIds）の取得を行う
      const episode = await db.query.vibeMemories.findFirst({
        where: eq(vibeMemories.id, id),
      });

      if (!episode) {
        const errPayload = { success: false, error: 'Episode not found', id };
        logger({ event: 'cli.delete.error', ...errPayload, level: 'error' });
        process.stdout.write(`${JSON.stringify(errPayload)}\n`);
        process.exit(1);
      }

      const metadata = episode.metadata as { sourceIds?: string[] } | null;
      const { sourceIds } = metadata || {};
      const episodeEntityId = `episode/${episode.id}`;

      // 2. 関連するデータの物理削除をアトミックに行う (TRANSACTION)
      logger({ event: 'cli.delete.start', id, level: 'info' });

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
            logger({ event: 'cli.delete.raw_memories', count: sourceIds.length });
          }

          // (d) エピソード記憶本体を最後に削除
          await tx.delete(vibeMemories).where(eq(vibeMemories.id, episode.id));
        });

        const successPayload = {
          success: true,
          id,
          message: 'Physical deletion completed successfully',
        };
        logger({ event: 'cli.delete.done', ...successPayload });
        process.stdout.write(`${JSON.stringify(successPayload)}\n`);
        process.exit(0);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const errPayload = { success: false, error: `Transaction failed: ${message}`, id };
        logger({ event: 'cli.delete.fail', ...errPayload, level: 'error' });
        process.stdout.write(`${JSON.stringify(errPayload)}\n`);
        process.exit(1);
      }
    } else if (command === 'register') {
      // ユーザーからの入力を raw memory にして即座に登録（統合は別途実行）
      const content = args[1];
      const customSessionId = args[2];
      if (!content) throw new Error('Missing content');

      const sessionId = customSessionId || `manual-reg-${Date.now()}`;

      // 1. Raw memory として登録
      logger({ event: 'cli.register.start', contentLength: content.length });
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

      const successPayload = {
        success: true,
        rawId: raw.id,
        sessionId,
        message: 'Raw memory registered',
      };
      logger({ event: 'cli.register.done', ...successPayload });
      process.stdout.write(`${JSON.stringify(successPayload)}\n`);
      process.exit(0);
    } else if (command === 'consolidate') {
      // 指定されたセッション、または最新のセッションを統合してエピソード化
      const sessionId = args[1];
      if (!sessionId) throw new Error('Missing session ID for consolidation');

      logger({ event: 'cli.consolidate.start', sessionId, level: 'info' });
      const result = await consolidateEpisodes(sessionId, { minRawCount: 1 });

      if (result) {
        logger({ event: 'cli.consolidate.done', ...result });
        process.stdout.write(`${JSON.stringify({ success: true, ...result })}\n`);
        process.exit(0);
      } else {
        const skipPayload = {
          success: false,
          error: 'Consolidation skipped (not enough data or already processed)',
          strict,
        };
        logger({ event: 'cli.consolidate.skip', ...skipPayload, level: 'warn' });
        process.stdout.write(`${JSON.stringify(skipPayload)}\n`);
        process.exit(strict ? 1 : 0);
      }
    } else {
      process.stderr.write(
        'Unknown command. Use: list, delete <id>, register <content>, consolidate <sessionId> [--strict] [--verbose] [--run-id=<id>]\n',
      );
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger({ event: 'cli.error', message, level: 'error' });
    process.stdout.write(`${JSON.stringify({ success: false, error: message })}\n`);
    process.exit(1);
  } finally {
    await runLogger.flush();
  }
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ success: false, error: err.message })}\n`);
  process.exit(1);
});
