import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities, vibeMemories } from '../db/schema.js';
import { consolidateEpisodes } from '../services/consolidation.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'list') {
    const eps = await db
      .select()
      .from(vibeMemories)
      .where(eq(vibeMemories.memoryType, 'episode'))
      .orderBy(desc(vibeMemories.createdAt));

    console.log(JSON.stringify(eps, null, 2));
  } else if (command === 'delete') {
    const id = args[1];
    if (!id) throw new Error('Missing episode ID');

    // 関連するエンティティも削除を試みる
    const entry = await db.query.vibeMemories.findFirst({
      where: eq(vibeMemories.id, id),
    });

    await db.delete(vibeMemories).where(eq(vibeMemories.id, id));

    // エンティティ側のクリーニング (metadata.memoryId に IDが入っているパターンが多い)
    // 簡易的に ID パスを含んでいるものを削除
    // await db.delete(entities).where(like(entities.id, `%${id}%`));
    // ^ 本来は安全なエンティティ削除ロジックが必要だが、まずはメモリ側を優先

    console.log(JSON.stringify({ success: true, id }));
  } else if (command === 'register') {
    // ユーザーからの入力を raw memory にして即座に統合
    const content = args[1];
    if (!content) throw new Error('Missing content');

    const sessionId = `manual-reg-${Date.now()}`;

    // 1. Raw memory として一旦登録
    const [raw] = await db
      .insert(vibeMemories)
      .values({
        content,
        embedding: new Array(384).fill(0), // ダミー、後で consolidate 内で episode 用に生成される
        memoryType: 'raw',
        sessionId,
        isSynthesized: false,
      })
      .returning();

    // 2. 統合処理を走らせる (minRawCount=1 で実行)
    const result = await consolidateEpisodes(sessionId, { minRawCount: 1 });

    if (result) {
      console.log(JSON.stringify({ success: true, ...result }));
    } else {
      console.log(JSON.stringify({ success: false, error: 'Consolidation failed' }));
    }
  } else {
    console.error('Unknown command. Use: list, delete <id>, register <content>');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
