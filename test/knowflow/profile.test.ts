import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadKnowflowProfile,
  mergeLlmConfig,
  resolveProfilePath,
} from '../../src/services/knowflow/utils/profile';

const baseLlmConfig = {
  apiBaseUrl: 'http://localhost:11434',
  apiPath: '/v1/chat/completions',
  apiKeyEnv: 'API_KEY',
  model: 'gemma3',
  temperature: 0,
  timeoutMs: 30_000,
  maxRetries: 3,
  retryDelayMs: 500,
  enableCliFallback: true,
  cliCommand: 'llm',
  cliPromptMode: 'arg' as const,
  cliPromptPlaceholder: '{{prompt}}',
};

describe('knowflow profile loader', () => {
  it('resolves named profile to profiles directory', () => {
    const cwd = '/tmp/gnosis';
    expect(resolveProfilePath('default', cwd)).toBe('/tmp/gnosis/profiles/default.toml');
  });

  it('resolves absolute path as-is', () => {
    const cwd = '/tmp/gnosis';
    expect(resolveProfilePath('/etc/gnosis/profile.toml', cwd)).toBe('/etc/gnosis/profile.toml');
  });

  it('resolves relative path with slash', () => {
    const cwd = '/tmp/gnosis';
    expect(resolveProfilePath('./my/profile.toml', cwd)).toBe('/tmp/gnosis/my/profile.toml');
  });

  it('throws when profile path is empty', () => {
    expect(() => resolveProfilePath('', '/tmp')).toThrow('must not be empty');
  });

  it('returns null when profileInput is undefined', async () => {
    const result = await loadKnowflowProfile(undefined, '/tmp');
    expect(result).toBeNull();
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
`,
      'utf-8',
    );

    const loaded = await loadKnowflowProfile(path, dir);
    expect(loaded).not.toBeNull();
    expect(loaded?.profile.localLlmPath).toBe('/tmp/localLlm');
    expect(loaded?.profile.knowflow?.llm?.model).toBe('test-model');
  });

  it('parses boolean and number values in TOML', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gnosis-toml-'));
    const path = join(dir, 'boolnum.toml');
    await writeFile(
      path,
      `
[knowflow.llm]
maxRetries = 2
enableCliFallback = true
`,
      'utf-8',
    );

    const loaded = await loadKnowflowProfile(path, dir);
    expect(loaded?.profile.knowflow?.llm?.maxRetries).toBe(2);
    expect(loaded?.profile.knowflow?.llm?.enableCliFallback).toBe(true);
  });

  it('parses quoted string values in TOML', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gnosis-toml-'));
    const path = join(dir, 'quoted.toml');
    await writeFile(
      path,
      `
[knowflow.llm]
model = "my-custom-model"
`,
      'utf-8',
    );

    const loaded = await loadKnowflowProfile(path, dir);
    expect(loaded?.profile.knowflow?.llm?.model).toBe('my-custom-model');
  });
});

describe('mergeLlmConfig', () => {
  it('returns base config when no override', () => {
    const result = mergeLlmConfig(baseLlmConfig);
    expect(result).toEqual(baseLlmConfig);
  });

  it('merges override fields into base', () => {
    const result = mergeLlmConfig(baseLlmConfig, { model: 'llama3', maxRetries: 1 });
    expect(result.model).toBe('llama3');
    expect(result.maxRetries).toBe(1);
    expect(result.apiBaseUrl).toBe(baseLlmConfig.apiBaseUrl);
  });

  it('returns original base when override is undefined', () => {
    const result = mergeLlmConfig(baseLlmConfig, undefined);
    expect(result).toEqual(baseLlmConfig);
  });
});
