import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKnowflowProfile, resolveProfilePath } from '../../src/services/knowflow/utils/profile';

describe('knowflow profile loader', () => {
  it('resolves named profile to profiles directory', () => {
    const cwd = '/tmp/gnosis';
    expect(resolveProfilePath('default', cwd)).toBe('/tmp/gnosis/profiles/default.toml');
  });

  it('loads profile from explicit path and parses values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gnosis-profile-'));
    const path = join(dir, 'profile.toml');
    await writeFile(
      path,
      `
localLlmPath = "/tmp/localLlm"

[knowflow.llm]
model = "test-model"
maxRetries = 1

[knowflow.budget]
userBudget = 9
`,
      'utf-8',
    );

    const loaded = await loadKnowflowProfile(path, dir);
    expect(loaded).not.toBeNull();
    expect(loaded?.profile.localLlmPath).toBe('/tmp/localLlm');
    expect(loaded?.profile.knowflow?.llm?.model).toBe('test-model');
    expect(loaded?.profile.knowflow?.budget?.userBudget).toBe(9);
  });
});
