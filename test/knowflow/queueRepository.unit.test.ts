import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { topicTasks } from '../../src/db/schema.js';
import { PgJsonbQueueRepository } from '../../src/services/knowflow/queue/pgJsonbRepository.js';

describe('PgJsonbQueueRepository (unit)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock
  let mockDb: any;
  let repository: PgJsonbQueueRepository;

  // biome-ignore lint/suspicious/noExplicitAny: mock
  const createMockTask = (id: string, overrides: any = {}) => ({
    id,
    topic: 'test-topic',
    mode: 'directed',
    source: 'user',
    priority: 10,
    dedupeKey: `key-${id}`,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  // biome-ignore lint/suspicious/noExplicitAny: mock
  const createMockChain = (data: any[] = []) => {
    // biome-ignore lint/suspicious/noExplicitAny: mock
    const chain: any = {
      where: mock(() => chain),
      orderBy: mock(() => chain),
      limit: mock(() => chain),
      for: mock(() => chain),
      onConflictDoNothing: mock(() => chain),
      onConflictDoUpdate: mock(() => chain),
      returning: mock(async () => data),
      // biome-ignore lint/suspicious/noThenProperty: drizzle thenable
      // biome-ignore lint/suspicious/noExplicitAny: mock
      then: (resolve: any) => Promise.resolve(data).then(resolve),
    };
    return chain;
  };

  beforeEach(() => {
    mockDb = {
      select: mock(() => ({ from: mock(() => createMockChain([])) })),
      insert: mock(() => ({ values: mock(() => createMockChain([])) })),
      update: mock(() => ({ set: mock(() => ({ where: mock(() => createMockChain([])) })) })),
      // biome-ignore lint/suspicious/noExplicitAny: mock
      transaction: mock(async (callback: any) => callback(mockDb)),
    };
    repository = new PgJsonbQueueRepository(mockDb);
  });

  it('enqueues a new task with dedupe check', async () => {
    mockDb.select.mockReturnValueOnce({ from: () => createMockChain([]) });
    mockDb.insert.mockReturnValueOnce({ values: () => createMockChain([{ id: 't1' }]) });

    const result = await repository.enqueue({
      topic: 'test',
      mode: 'directed',
      source: 'user',
      priority: 10,
    });

    expect(result.deduped).toBe(false);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('returns existing task if deduped', async () => {
    const task = createMockTask('t1');
    mockDb.select.mockReturnValueOnce({
      from: () => createMockChain([{ id: 't1', payload: task }]),
    });

    const result = await repository.enqueue({
      topic: 'test',
      mode: 'directed',
      source: 'user',
    });

    expect(result.deduped).toBe(true);
    expect(result.task.id).toBe('t1');
  });

  it('dequeues and locks a task', async () => {
    const task = createMockTask('t1');
    mockDb.select.mockReturnValueOnce({
      from: () => createMockChain([{ id: 't1', payload: task }]),
    });

    const result = await repository.dequeueAndLock('worker-1');

    expect(result).not.toBeNull();
    expect(result?.status).toBe('running');
    expect(result?.lockOwner).toBe('worker-1');
  });

  it('marks task as done', async () => {
    const task = createMockTask('t1', { status: 'running' });
    mockDb.select.mockReturnValueOnce({
      from: () => createMockChain([{ id: 't1', payload: task }]),
    });

    const result = await repository.markDone('t1', 'finished ok');

    expect(result.status).toBe('done');
    expect(result.resultSummary).toBe('finished ok');
  });

  it('clears stale tasks', async () => {
    const task = createMockTask('t1', { status: 'running' });
    mockDb.select.mockReturnValueOnce({
      from: () => createMockChain([{ id: 't1', payload: task }]),
    });

    const count = await repository.clearStaleTasks(3600000);

    expect(count).toBe(1);
    expect(mockDb.update).toHaveBeenCalled();
  });
});
