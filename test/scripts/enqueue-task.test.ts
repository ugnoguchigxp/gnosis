import { describe, expect, test } from 'bun:test';

describe('enqueue-task script validation', () => {
  test('requires topic argument', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/scripts/enqueue-task.ts', '--json'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    const result = JSON.parse(stderr);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Usage');
  });

  test('rejects topic with invalid characters', async () => {
    const proc = Bun.spawn(
      ['bun', 'run', 'src/scripts/enqueue-task.ts', '--topic', 'test;rm', '--json'],
      {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    const result = JSON.parse(stderr);
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid characters');
  });

  test('rejects topic exceeding max length', async () => {
    const longTopic = 'a'.repeat(501);
    const proc = Bun.spawn(
      ['bun', 'run', 'src/scripts/enqueue-task.ts', '--topic', longTopic, '--json'],
      {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    const result = JSON.parse(stderr);
    expect(result.success).toBe(false);
    expect(result.error).toContain('less than 500 characters');
  });

  test('rejects invalid mode', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        'run',
        'src/scripts/enqueue-task.ts',
        '--topic',
        'test',
        '--mode',
        'invalid',
        '--json',
      ],
      {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    const result = JSON.parse(stderr);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Validation error');
  });

  test('rejects priority out of range', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        'run',
        'src/scripts/enqueue-task.ts',
        '--topic',
        'test',
        '--priority',
        '150',
        '--json',
      ],
      {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    const result = JSON.parse(stderr);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Validation error');
  });
});
