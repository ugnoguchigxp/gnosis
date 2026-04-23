import { db } from '../db/index.js';
import { saveEntities, saveRelations } from '../services/graph.js';
import { generateEmbedding } from '../services/memory.js';
import { recordOutcome } from '../services/procedure.js';
import { generateEntityId } from '../utils/entityId.js';

async function main() {
  console.info('Seeding initial wisdom...');

  const goalName = 'Gnosis Hook のセットアップと運用安定化';
  const goalId = generateEntityId('goal', goalName);

  const taskNames = [
    'MCPサーバープロセスの直結化（bash排除）とシングルトン化による安定化',
    'bun run hooks:setup による基本ルールの配布とエージェント指示の自動更新',
    '.env での GNOSIS_HOOKS_ENABLED=true 設定による機能有効化',
    'カスタムルール（console-log-check）の作成とスキーマ検証の実施',
  ];

  // 1. Goal Entity
  await saveEntities(
    [
      {
        id: goalId,
        type: 'goal',
        name: goalName,
        description:
          'AIエージェントの作業品質を自動担保するための Hook システムを構築し、安定稼働させる手順。',
        confidence: 1.0,
        provenance: 'seed',
      },
    ],
    db,
    generateEmbedding,
  );

  // 2. Task Entities
  const taskEntities = taskNames.map((name) => ({
    id: generateEntityId('task', name),
    type: 'task',
    name: name,
    description: name,
    confidence: 0.7,
    provenance: 'seed',
  }));

  await saveEntities(taskEntities, db, generateEmbedding);

  // 3. Relationships
  const hasStepRelations = taskEntities.map((task) => ({
    sourceId: goalId,
    targetId: task.id,
    relationType: 'has_step',
    weight: 1.0,
  }));

  // 前提条件（順序）の構築
  const flowRelations = [];
  for (let i = 0; i < taskEntities.length - 1; i++) {
    flowRelations.push({
      sourceId: taskEntities[i].id,
      targetId: taskEntities[i + 1].id,
      relationType: 'precondition',
      weight: 1.0,
    });
  }

  await saveRelations([...hasStepRelations, ...flowRelations], db);

  // 4. Record Outcome
  const result = await recordOutcome({
    goalId,
    sessionId: 'initial-wisdom-seed',
    taskResults: taskEntities.map((task) => ({
      taskId: task.id,
      followed: true,
      succeeded: true,
      note: '完璧に動作を確認。',
    })),
  });

  console.info('Wisdom seeded successfully!', result);
}

main().catch(console.error);
