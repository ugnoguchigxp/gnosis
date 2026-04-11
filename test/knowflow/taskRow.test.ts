import { describe, expect, it } from 'bun:test';
import { createTask } from '../../src/knowflow/domain/task';
import { parseTaskPayload, toTaskRowFields } from '../../src/knowflow/queue/taskRow';

describe('queue task row mapping', () => {
  it('maps task to db row fields', () => {
    const task = createTask({
      topic: 'TypeScript Compiler API',
      mode: 'directed',
      source: 'user',
    });

    const fields = toTaskRowFields(task);
    expect(fields.id).toBe(task.id);
    expect(fields.dedupeKey).toBe(task.dedupeKey);
    expect(fields.status).toBe('pending');
    expect(fields.priority).toBe(100);
    expect(fields.payload.topic).toBe('TypeScript Compiler API');
  });

  it('parses payload into validated task', () => {
    const task = createTask({
      topic: 'Graph RAG',
      mode: 'explore',
      source: 'cron',
    });

    const parsed = parseTaskPayload(JSON.parse(JSON.stringify(task)));
    expect(parsed.id).toBe(task.id);
    expect(parsed.mode).toBe('explore');
    expect(parsed.source).toBe('cron');
  });
});
