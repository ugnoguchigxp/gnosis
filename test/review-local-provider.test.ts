import { describe, expect, test } from 'bun:test';
import { buildLocalProviderSpawnEnv } from '../src/services/review/llm/localProvider.js';

describe('review local provider env safety', () => {
  test('forces safe MLX mode in seatbelt for gemma4', () => {
    const env = buildLocalProviderSpawnEnv('gemma4', {
      CODEX_SANDBOX: 'seatbelt',
      LOCAL_LLM_ALLOW_MLX_IN_SEATBELT: '1',
    });

    expect(env.LOCAL_LLM_ALLOW_MLX_IN_SEATBELT).toBe('0');
  });

  test('keeps unsafe override only when explicit review escape hatch is enabled', () => {
    const env = buildLocalProviderSpawnEnv('gemma4', {
      CODEX_SANDBOX: 'seatbelt',
      LOCAL_LLM_ALLOW_MLX_IN_SEATBELT: '1',
      GNOSIS_REVIEW_ALLOW_UNSAFE_MLX_IN_SEATBELT: '1',
    });

    expect(env.LOCAL_LLM_ALLOW_MLX_IN_SEATBELT).toBe('1');
  });

  test('does not touch MLX override outside seatbelt', () => {
    const env = buildLocalProviderSpawnEnv('bonsai', {
      CODEX_SANDBOX: 'none',
      LOCAL_LLM_ALLOW_MLX_IN_SEATBELT: '1',
    });

    expect(env.LOCAL_LLM_ALLOW_MLX_IN_SEATBELT).toBe('1');
  });
});
