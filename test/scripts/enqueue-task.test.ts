import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

describe('enqueue-task script validation', () => {
  function createChildEnv(): NodeJS.ProcessEnv {
    return Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          key !== 'NODE_V8_COVERAGE' &&
          !key.startsWith('BUN_TEST') &&
          !key.startsWith('BUN_COVERAGE') &&
          !key.startsWith('BUN_RUNTIME_') &&
          !key.startsWith('__BUN'),
      ),
    );
  }

  function parseJsonFromOutput(output: string) {
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      if (line.startsWith('{') && line.endsWith('}')) {
        return JSON.parse(line) as { success: boolean; error?: string };
      }
    }

    throw new Error(`No JSON object found in output: ${output.slice(0, 200)}`);
  }

  test('requires topic argument', async () => {
    const proc = spawnSync('bun', ['run', 'src/scripts/enqueue-task.ts', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: createChildEnv(),
      timeout: 5000,
    });

    const result = parseJsonFromOutput(`${proc.stderr}\n${proc.stdout}`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Usage');
  });

  test('rejects topic with invalid characters', async () => {
    const proc = spawnSync(
      'bun',
      ['run', 'src/scripts/enqueue-task.ts', '--topic', 'test;rm', '--json'],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: createChildEnv(),
        timeout: 5000,
      },
    );

    const result = parseJsonFromOutput(`${proc.stderr}\n${proc.stdout}`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid characters');
  });

  test('rejects topic exceeding max length', async () => {
    const longTopic = 'a'.repeat(501);
    const proc = spawnSync(
      'bun',
      ['run', 'src/scripts/enqueue-task.ts', '--topic', longTopic, '--json'],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: createChildEnv(),
        timeout: 5000,
      },
    );

    const result = parseJsonFromOutput(`${proc.stderr}\n${proc.stdout}`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('less than 500 characters');
  });

  test('rejects invalid mode', async () => {
    const proc = spawnSync(
      'bun',
      ['src/scripts/enqueue-task.ts', '--topic', 'test', '--mode', 'invalid', '--json'],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: createChildEnv(),
        timeout: 5000,
      },
    );

    const result = parseJsonFromOutput(`${proc.stderr}\n${proc.stdout}`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Validation error');
  });

  test('rejects priority out of range', async () => {
    const proc = spawnSync(
      'bun',
      ['src/scripts/enqueue-task.ts', '--topic', 'test', '--priority', '150', '--json'],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: createChildEnv(),
        timeout: 5000,
      },
    );

    const result = parseJsonFromOutput(`${proc.stderr}\n${proc.stdout}`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Validation error');
  });
});
