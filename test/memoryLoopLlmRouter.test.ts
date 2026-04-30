import { describe, expect, it } from 'bun:test';
import {
  type MemoryLoopRuntimeConfigForTest,
  buildMemoryLoopSpawnEnv,
  routeMemoryLoopLlm,
} from '../src/services/memoryLoopLlmRouter.js';

const runtime: MemoryLoopRuntimeConfigForTest = {
  allowCloud: false,
  cloudProvider: 'openai',
  defaultAlias: 'gemma4',
  lightAlias: 'bonsai',
  maxLocalRetries: 3,
  minQualityScore: 0.5,
  scripts: {
    gemma4: '/mock/gemma4',
    bonsai: '/mock/bonsai',
    openai: '/mock/openai',
    bedrock: '/mock/bedrock',
  },
};

describe('routeMemoryLoopLlm', () => {
  it('uses local primary route for first attempt', () => {
    const result = routeMemoryLoopLlm(
      { taskKind: 'distillation', retryCount: 0, riskLevel: 'low' },
      runtime,
    );
    expect(result.alias).toBe('gemma4');
    expect(result.cloudEnabledForAttempt).toBe(false);
  });

  it('uses light local alias for classification task at first attempt', () => {
    const result = routeMemoryLoopLlm(
      { taskKind: 'classification', retryCount: 0, riskLevel: 'low' },
      runtime,
    );
    expect(result.alias).toBe('bonsai');
    expect(result.cloudEnabledForAttempt).toBe(false);
  });

  it('honors a preferred local alias for classification task', () => {
    const result = routeMemoryLoopLlm(
      {
        taskKind: 'classification',
        retryCount: 0,
        riskLevel: 'low',
        preferredLocalAlias: 'gemma4',
      },
      runtime,
    );
    expect(result.alias).toBe('gemma4');
    expect(result.cloudEnabledForAttempt).toBe(false);
  });

  it('can use a preferred local fallback alias for retry attempts', () => {
    const result = routeMemoryLoopLlm(
      {
        taskKind: 'classification',
        retryCount: 1,
        riskLevel: 'low',
        preferredLocalAlias: 'gemma4',
        fallbackLocalAlias: 'bonsai',
      },
      runtime,
    );
    expect(result.alias).toBe('bonsai');
    expect(result.cloudEnabledForAttempt).toBe(false);
  });

  it('can disable cloud fallback even when runtime allows cloud', () => {
    const result = routeMemoryLoopLlm(
      {
        taskKind: 'classification',
        retryCount: 3,
        riskLevel: 'high',
        preferredLocalAlias: 'gemma4',
        fallbackLocalAlias: 'bonsai',
        allowCloudFallback: false,
      },
      { ...runtime, allowCloud: true, cloudProvider: 'openai' },
    );
    expect(result.alias).toBe('bonsai');
    expect(result.allowCloud).toBe(false);
    expect(result.cloudEnabledForAttempt).toBe(false);
  });

  it('falls back to secondary local alias on retry', () => {
    const result = routeMemoryLoopLlm(
      { taskKind: 'distillation', retryCount: 1, riskLevel: 'low' },
      runtime,
    );
    expect(result.alias).toBe('bonsai');
    expect(result.cloudEnabledForAttempt).toBe(false);
  });

  it('does not select cloud alias when allowCloud=false', () => {
    const result = routeMemoryLoopLlm(
      { taskKind: 'evaluation', retryCount: 4, riskLevel: 'high', qualityScore: 0.1 },
      runtime,
    );
    expect(result.alias).toBe('bonsai');
    expect(result.cloudEnabledForAttempt).toBe(false);
  });

  it('selects cloud alias when allowCloud=true and retries exceeded', () => {
    const result = routeMemoryLoopLlm(
      { taskKind: 'distillation', retryCount: 3, riskLevel: 'low' },
      { ...runtime, allowCloud: true, cloudProvider: 'bedrock' },
    );
    expect(result.alias).toBe('bedrock');
    expect(result.cloudEnabledForAttempt).toBe(true);
    expect(result.reason).toBe('local-retries-exceeded');
  });

  it('forces safe MLX mode in seatbelt for local alias', () => {
    const env = buildMemoryLoopSpawnEnv('gemma4', {
      CODEX_SANDBOX: 'seatbelt',
      LOCAL_LLM_ALLOW_MLX_IN_SEATBELT: '1',
    });
    expect(env.LOCAL_LLM_ALLOW_MLX_IN_SEATBELT).toBe('0');
  });

  it('keeps override for cloud alias', () => {
    const env = buildMemoryLoopSpawnEnv('openai', {
      CODEX_SANDBOX: 'seatbelt',
      LOCAL_LLM_ALLOW_MLX_IN_SEATBELT: '1',
    });
    expect(env.LOCAL_LLM_ALLOW_MLX_IN_SEATBELT).toBe('1');
  });

  it('allows unsafe MLX only with explicit memory-loop escape hatch', () => {
    const env = buildMemoryLoopSpawnEnv('bonsai', {
      CODEX_SANDBOX: 'seatbelt',
      LOCAL_LLM_ALLOW_MLX_IN_SEATBELT: '1',
      GNOSIS_MEMORY_LOOP_ALLOW_UNSAFE_MLX_IN_SEATBELT: '1',
    });
    expect(env.LOCAL_LLM_ALLOW_MLX_IN_SEATBELT).toBe('1');
  });
});
