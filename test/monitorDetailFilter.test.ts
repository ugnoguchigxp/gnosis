import { describe, expect, test } from 'bun:test';
import { isTaskLogMatch } from '../src/scripts/monitor-detail';

describe('monitor detail log filter', () => {
  test('matches only exact taskId', () => {
    expect(isTaskLogMatch({ taskId: 'task-1' }, 'task-1')).toBe(true);
    expect(isTaskLogMatch({ taskId: 'task-2' }, 'task-1')).toBe(false);
  });

  test('does not match entries without taskId', () => {
    expect(isTaskLogMatch({}, 'task-1')).toBe(false);
    expect(isTaskLogMatch({ taskId: 123 }, 'task-1')).toBe(false);
  });
});
