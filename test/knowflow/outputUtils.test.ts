import { describe, expect, it } from 'bun:test';
import { renderOutput, resolveOutputFormat } from '../../src/services/knowflow/utils/output';

describe('knowflow output utils', () => {
  it('resolves default output format to json', () => {
    expect(resolveOutputFormat({})).toBe('json');
  });

  it('resolves table output format', () => {
    expect(resolveOutputFormat({ table: true })).toBe('table');
  });

  it('rejects mutually exclusive format flags', () => {
    expect(() => resolveOutputFormat({ json: true, table: true })).toThrow(
      '--json and --table cannot be used together',
    );
  });

  it('renders table output with flattened fields', () => {
    const out = renderOutput(
      {
        command: 'enqueue',
        task: {
          id: 't1',
          topic: 'topic-a',
        },
      },
      'table',
    );
    expect(out).toContain('command');
    expect(out).toContain('task.id');
    expect(out).toContain('topic-a');
  });
});
