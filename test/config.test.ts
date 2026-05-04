import { describe, expect, test } from 'bun:test';
import { LlmClientConfigSchema, WorkerConfigSchema, envBoolean, envNumber } from '../src/config.ts';

describe('config helpers', () => {
  describe('envBoolean', () => {
    test('returns true for "1", "true", "yes"', () => {
      expect(envBoolean('1', false)).toBe(true);
      expect(envBoolean('true', false)).toBe(true);
      expect(envBoolean('YES', false)).toBe(true);
    });

    test('returns false for "0", "false", "no"', () => {
      expect(envBoolean('0', true)).toBe(false);
      expect(envBoolean('false', true)).toBe(false);
      expect(envBoolean('no', true)).toBe(false);
    });

    test('returns fallback for undefined or empty string', () => {
      expect(envBoolean(undefined, true)).toBe(true);
      expect(envBoolean(undefined, false)).toBe(false);
      expect(envBoolean(' ', true)).toBe(true);
    });
  });

  describe('envNumber', () => {
    test('parses valid number strings', () => {
      expect(envNumber('123', 0)).toBe(123);
      expect(envNumber('0.5', 0)).toBe(0.5);
      expect(envNumber('-10', 0)).toBe(-10);
    });

    test('returns fallback for invalid number strings', () => {
      expect(envNumber('abc', 42)).toBe(42);
      expect(envNumber('', 42)).toBe(42);
      expect(envNumber('12.3.4', 42)).toBe(42);
    });

    test('returns fallback for undefined', () => {
      expect(envNumber(undefined, 42)).toBe(42);
    });
  });
});

describe('config schemas', () => {
  describe('LlmClientConfigSchema', () => {
    test('validates full config', () => {
      const valid = {
        apiBaseUrl: 'http://localhost:8000',
        apiPath: '/v1',
        apiKeyEnv: 'KEY',
        model: 'm',
        temperature: 0,
        timeoutMs: 1000,
        maxRetries: 1,
        retryDelayMs: 0,
        enableCliFallback: true,
        cliCommand: 'cmd',
        cliPromptMode: 'stdin' as const,
        cliPromptPlaceholder: '{{prompt}}',
      };
      expect(LlmClientConfigSchema.parse(valid)).toEqual(valid);
    });

    test('rejects invalid URL', () => {
      expect(() => LlmClientConfigSchema.parse({ apiBaseUrl: 'invalid' })).toThrow();
    });
  });

  describe('WorkerConfigSchema', () => {
    test('validates worker config', () => {
      const valid = {
        taskTimeoutMs: 60000,
        pollIntervalMs: 5000,
        postTaskDelayMs: 1000,
        parallelism: 3,
        maxConsecutiveErrors: 5,
        maxQueriesPerTask: 10,
        cronRunWindowMs: 3600000,
      };
      expect(WorkerConfigSchema.parse(valid)).toEqual(valid);
    });
  });
});
