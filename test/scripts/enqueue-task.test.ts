import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

describe('enqueue-task script validation', () => {
  const BUN_PATH = process.execPath;

  function createChildEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NODE_V8_COVERAGE: undefined,
      BUN_TEST: undefined,
      BUN_COVERAGE: undefined,
      BUN_RUNTIME_SPECIFIC: undefined,
    };
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
    const proc = spawnSync(BUN_PATH, ['run', 'src/scripts/enqueue-task.ts', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: createChildEnv(),
      timeout: 5000,
    });

    const result = parseJsonFromOutput(`${proc.stderr}\n${proc.stdout}`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Usage');
  });

  test.skip('rejects topic with invalid characters', async () => {
    const proc = spawnSync(
      BUN_PATH,
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
      BUN_PATH,
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
      BUN_PATH,
      ['run', 'src/scripts/enqueue-task.ts', '--topic', 'test', '--mode', 'invalid', '--json'],
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
      BUN_PATH,
      ['run', 'src/scripts/enqueue-task.ts', '--topic', 'test', '--priority', '150', '--json'],
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
