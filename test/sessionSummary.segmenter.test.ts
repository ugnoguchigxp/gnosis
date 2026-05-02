import { expect, test } from 'bun:test';
import { splitSessionTurns } from '../src/services/sessionSummary/segmenter.js';

test('splitSessionTurns normalizes chronological order and splits by user message', () => {
  const turns = splitSessionTurns([
    { id: '3', role: 'assistant', content: 'done', createdAt: '2026-05-02T00:00:03Z' },
    { id: '1', role: 'user', content: 'first request', createdAt: '2026-05-02T00:00:01Z' },
    {
      id: '2',
      role: 'assistant',
      content: 'running bun run typecheck',
      createdAt: '2026-05-02T00:00:02Z',
    },
    { id: '4', role: 'user', content: 'second request', createdAt: '2026-05-02T00:00:04Z' },
  ]);

  expect(turns).toHaveLength(2);
  expect(turns[0]?.messages[0]?.content).toBe('first request');
  expect(turns[0]?.messages[1]?.content).toContain('typecheck');
  expect(turns[1]?.messages[0]?.content).toBe('second request');
});

test('splitSessionTurns excludes AGENTS and environment context from turn messages', () => {
  const turns = splitSessionTurns([
    {
      id: '1',
      role: 'user',
      content: '# AGENTS.md instructions for /repo\n<environment_context>\nreal task body',
      createdAt: '2026-05-02T00:00:01Z',
    },
    {
      id: '2',
      role: 'assistant',
      content: '<collaboration_mode>\nrun rg',
      createdAt: '2026-05-02T00:00:02Z',
    },
  ]);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.messages[0]?.content).toContain('real task body');
  expect(turns[0]?.messages[0]?.content).not.toContain('AGENTS.md');
  expect(turns[0]?.messages[1]?.content).toBe('run rg');
});
