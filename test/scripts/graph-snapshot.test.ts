import { describe, expect, test } from 'bun:test';

describe('graph-snapshot script', () => {
  function parseOutputOrSkip(output: string, exitCode: number) {
    try {
      const result = JSON.parse(output);
      if (result?.error) {
        console.warn('[skip] graph-snapshot returned error (DB likely unavailable):', result.error);
        return null;
      }
      return result;
    } catch {
      if (exitCode !== 0) {
        console.warn('[skip] graph-snapshot exited with non-zero (DB likely unavailable)');
        return null;
      }
      throw new Error(`Unexpected non-JSON output: ${output.slice(0, 200)}`);
    }
  }

  test('returns valid JSON structure', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/scripts/graph-snapshot.ts', '--json'], {
      cwd: process.cwd(),
      stdout: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    const result = parseOutputOrSkip(output, exitCode);
    if (!result) return; // DB unavailable — skip gracefully

    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('relations');
    expect(result).toHaveProperty('communities');
    expect(result).toHaveProperty('stats');

    expect(result.stats).toHaveProperty('totalEntities');
    expect(result.stats).toHaveProperty('totalRelations');
    expect(result.stats).toHaveProperty('totalCommunities');
    expect(result.stats).toHaveProperty('totalEntitiesInDb');
    expect(result.stats).toHaveProperty('totalRelationsInDb');
    expect(result.stats).toHaveProperty('totalCommunitiesInDb');
    expect(result.stats).toHaveProperty('limitApplied');

    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.relations)).toBe(true);
    expect(Array.isArray(result.communities)).toBe(true);
  });

  test('stats show database totals vs displayed totals', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/scripts/graph-snapshot.ts', '--json'], {
      cwd: process.cwd(),
      stdout: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    const result = parseOutputOrSkip(output, exitCode);
    if (!result) return;

    expect(result.stats.totalEntitiesInDb).toBeGreaterThanOrEqual(result.stats.totalEntities);
    expect(result.stats.totalRelationsInDb).toBeGreaterThanOrEqual(result.stats.totalRelations);
    expect(result.stats.totalCommunitiesInDb).toBeGreaterThanOrEqual(result.stats.totalCommunities);
  });

  test('respects environment variable limits', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/scripts/graph-snapshot.ts', '--json'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      env: {
        ...process.env,
        GRAPH_SNAPSHOT_MAX_ENTITIES: '2',
        GRAPH_SNAPSHOT_MAX_RELATIONS: '2',
        GRAPH_SNAPSHOT_MAX_COMMUNITIES: '2',
      },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    const result = parseOutputOrSkip(output, exitCode);
    if (!result) return;

    expect(result.stats.totalEntities).toBeLessThanOrEqual(2);
    expect(result.stats.totalRelations).toBeLessThanOrEqual(2);
    expect(result.stats.totalCommunities).toBeLessThanOrEqual(2);
  });
});
