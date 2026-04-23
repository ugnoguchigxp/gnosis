import { and, eq, inArray } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { entities, relations } from '../db/schema.js';
import { generateEntityId } from '../utils/entityId.js';

async function listGoals() {
  return await db
    .select()
    .from(entities)
    .where(eq(entities.type, 'goal'))
    .orderBy(entities.createdAt);
}

async function getProcedure(goalId: string) {
  // 1. Goal 自身の情報を取得
  const goal = await db.query.entities.findFirst({
    where: eq(entities.id, goalId),
  });
  if (!goal) throw new Error(`Goal ${goalId} not found`);

  // 2. 紐づく Task 群を取得
  const steps = await db
    .select({
      taskId: relations.targetId,
      taskName: entities.name,
      description: entities.description,
      confidence: entities.confidence,
    })
    .from(relations)
    .innerJoin(entities, eq(relations.targetId, entities.id))
    .where(and(eq(relations.sourceId, goalId), eq(relations.relationType, 'has_step')));

  // 3. Task 間の順序（precondition）や依存関係を取得
  const taskIds = steps.map((s) => s.taskId);
  const flows =
    taskIds.length > 0
      ? await db
          .select()
          .from(relations)
          .where(and(inArray(relations.sourceId, taskIds), inArray(relations.targetId, taskIds)))
      : [];

  return {
    goal,
    steps,
    flows,
  };
}

async function updateStepsOrder(goalId: string, stepsOrder: string[]) {
  const goal = await db.query.entities.findFirst({
    where: eq(entities.id, goalId),
  });
  if (!goal) throw new Error(`Goal ${goalId} not found`);

  const updatedMetadata = {
    ...((goal.metadata as object) || {}),
    stepsOrder,
  };

  await db.update(entities).set({ metadata: updatedMetadata }).where(eq(entities.id, goalId));

  return { success: true };
}

async function createCustomStep(goalId: string, name: string, description: string) {
  const taskId = generateEntityId('task', name);

  await db
    .insert(entities)
    .values({
      id: taskId,
      type: 'task',
      name,
      description,
      confidence: 1.0,
      provenance: 'human_manual',
    })
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        name,
        description,
        confidence: 1.0,
        provenance: 'human_manual',
      },
    });

  await addStep(goalId, taskId);

  return { id: taskId, name };
}

async function updateTaskConfidence(taskId: string, confidence: number) {
  const [updated] = await db
    .update(entities)
    .set({ confidence })
    .where(eq(entities.id, taskId))
    .returning();
  if (!updated) throw new Error(`Task ${taskId} not found`);
  return updated;
}

async function addStep(goalId: string, taskId: string) {
  const [relation] = await db
    .insert(relations)
    .values({
      sourceId: goalId,
      targetId: taskId,
      relationType: 'has_step',
      weight: 1.0,
    })
    .onConflictDoNothing()
    .returning();
  return relation;
}

async function removeStep(goalId: string, taskId: string) {
  const [deleted] = await db
    .delete(relations)
    .where(
      and(
        eq(relations.sourceId, goalId),
        eq(relations.targetId, taskId),
        eq(relations.relationType, 'has_step'),
      ),
    )
    .returning();

  if (!deleted) {
    throw new Error(`Step relationship not found between ${goalId} and ${taskId}`);
  }
  return { success: true };
}

async function main() {
  const args = process.argv.slice(2);
  const resource = args[0];
  const command = args[1];

  try {
    if (resource === 'goals') {
      if (command === 'list') {
        console.log(JSON.stringify(await listGoals(), null, 2));
        return;
      }
    }

    if (resource === 'procedure') {
      if (command === 'get') {
        const goalId = args[2]?.trim();
        if (!goalId) throw new Error('goalId is required');
        console.log(JSON.stringify(await getProcedure(goalId), null, 2));
        return;
      }
    }

    if (resource === 'task') {
      if (command === 'set-confidence') {
        const taskId = args[2];
        const confidence = Number.parseFloat(args[3]);
        if (!taskId || Number.isNaN(confidence)) {
          throw new Error('taskId and confidence are required');
        }
        console.log(JSON.stringify(await updateTaskConfidence(taskId, confidence), null, 2));
        return;
      }
      if (command === 'add-step') {
        const goalId = args[2]?.trim();
        const taskId = args[3]?.trim();
        if (!goalId || !taskId) throw new Error('goalId and taskId are required');
        console.log(JSON.stringify(await addStep(goalId, taskId), null, 2));
        return;
      }
      if (command === 'remove-step') {
        const goalId = args[2]?.trim();
        const taskId = args[3]?.trim();
        if (!goalId || !taskId) throw new Error('goalId and taskId are required');
        console.log(JSON.stringify(await removeStep(goalId, taskId), null, 2));
        return;
      }
      if (command === 'reorder') {
        const goalId = args[2];
        const stepsOrder = JSON.parse(args[3]);
        if (!goalId || !Array.isArray(stepsOrder)) {
          throw new Error('goalId and stepsOrder array are required');
        }
        console.log(JSON.stringify(await updateStepsOrder(goalId, stepsOrder), null, 2));
        return;
      }
      if (command === 'create-custom') {
        const goalId = args[2];
        const name = args[3];
        const description = args[4] || '';
        if (!goalId || !name) throw new Error('goalId and name are required');
        console.log(JSON.stringify(await createCustomStep(goalId, name, description), null, 2));
        return;
      }
    }

    throw new Error(
      'Unknown command. Use: goals list, procedure get <goalId>, task set-confidence <taskId> <value>, task add-step <goalId> <taskId>, or task remove-step <goalId> <taskId>',
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    await closeDbPool();
  }
}

main();
