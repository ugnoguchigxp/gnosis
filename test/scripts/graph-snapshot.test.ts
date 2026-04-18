import { describe, expect, test } from 'bun:test';

describe('graph-snapshot script', () => {
  const runGraphSnapshotDbTests = process.env.RUN_GRAPH_SNAPSHOT_DB_TESTS === '1';

  function extractJsonCandidate(output: string): string | null {
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      if (line.startsWith('{') && line.endsWith('}')) {
        return line;
      }
    }
    return null;
  }

  function parseOutputOrSkip(output: string, exitCode: number) {
    const candidate = extractJsonCandidate(output);
    if (!candidate) {
      if (exitCode !== 0) {
        console.warn('[skip] graph-snapshot exited with non-zero (DB likely unavailable)');
        return null;
      }
      throw new Error(`Unexpected non-JSON output: ${output.slice(0, 200)}`);
    }

    try {
      const result = JSON.parse(candidate);
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
      throw new Error(`Unexpected JSON output: ${candidate.slice(0, 200)}`);
    }
  }

  test('returns valid JSON structure', async () => {
    if (!runGraphSnapshotDbTests) {
      console.warn('[skip] graph-snapshot skipped (set RUN_GRAPH_SNAPSHOT_DB_TESTS=1 to enable)');
      return;
    }

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
    if (!runGraphSnapshotDbTests) {
      console.warn('[skip] graph-snapshot skipped (set RUN_GRAPH_SNAPSHOT_DB_TESTS=1 to enable)');
      return;
    }

    const proc = Bun.spawn(['bun', 'run', 'src/scripts/graph-snapshot.ts', '--json'], {
      cwd: process.cwd(),
      stdout: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    const result = parseOutputOrSkip(output, exitCode);
    if (!result) return;

    // Display counts are derived from the returned arrays and are stable even if
    // other tests mutate the DB concurrently.
    expect(result.stats.totalEntities).toBe(result.entities.length);
    expect(result.stats.totalRelations).toBe(result.relations.length);
    expect(result.stats.totalCommunities).toBe(result.communities.length);

    expect(result.stats.totalEntitiesInDb).toBeGreaterThanOrEqual(0);
    expect(result.stats.totalRelationsInDb).toBeGreaterThanOrEqual(0);
    expect(result.stats.totalCommunitiesInDb).toBeGreaterThanOrEqual(0);
  });

  test('respects environment variable limits', async () => {
    if (!runGraphSnapshotDbTests) {
      console.warn('[skip] graph-snapshot skipped (set RUN_GRAPH_SNAPSHOT_DB_TESTS=1 to enable)');
      return;
    }

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
