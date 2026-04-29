import { describe, expect, it } from 'bun:test';
import { resolveFrontierUseLlm } from '../../src/services/knowflow/cli.js';
import {
  parseArgMap,
  readBooleanFlag,
  readNumberFlag,
  readStringFlag,
} from '../../src/services/knowflow/utils/args.js';

describe('parseArgMap', () => {
  it('parses key=value style args', () => {
    const result = parseArgMap(['--topic', 'TypeScript', '--mode', 'directed']);
    expect(result).toEqual({ topic: 'TypeScript', mode: 'directed' });
  });

  it('parses boolean flag with no following value', () => {
    const result = parseArgMap(['--verbose']);
    expect(result).toEqual({ verbose: true });
  });

  it('treats arg as boolean when followed by another --flag', () => {
    const result = parseArgMap(['--a', '--b', 'value']);
    expect(result).toEqual({ a: true, b: 'value' });
  });

  it('ignores non-flag tokens before flags', () => {
    const result = parseArgMap(['node', 'script.js', '--topic', 'test']);
    expect(result).toEqual({ topic: 'test' });
  });

  it('returns empty object for empty args', () => {
    expect(parseArgMap([])).toEqual({});
  });

  it('handles trailing boolean flag', () => {
    const result = parseArgMap(['--topic', 'test', '--dry-run']);
    expect(result).toEqual({ topic: 'test', 'dry-run': true });
  });

  it('handles multiple key-value pairs', () => {
    const result = parseArgMap(['--a', '1', '--b', '2', '--c', '3']);
    expect(result).toEqual({ a: '1', b: '2', c: '3' });
  });
});

describe('readStringFlag', () => {
  it('returns string value when present', () => {
    expect(readStringFlag({ key: 'hello' }, 'key')).toBe('hello');
  });

  it('returns undefined for boolean flag', () => {
    expect(readStringFlag({ key: true }, 'key')).toBeUndefined();
  });

  it('returns undefined for missing key', () => {
    expect(readStringFlag({}, 'key')).toBeUndefined();
  });
});

describe('readNumberFlag', () => {
  it('parses a numeric string to number', () => {
    expect(readNumberFlag({ n: '42' }, 'n')).toBe(42);
  });

  it('parses a float string', () => {
    expect(readNumberFlag({ n: '3.14' }, 'n')).toBeCloseTo(3.14);
  });

  it('returns undefined for non-numeric string', () => {
    expect(readNumberFlag({ n: 'abc' }, 'n')).toBeUndefined();
  });

  it('returns undefined for boolean flag', () => {
    expect(readNumberFlag({ n: true }, 'n')).toBeUndefined();
  });

  it('returns undefined for missing key', () => {
    expect(readNumberFlag({}, 'n')).toBeUndefined();
  });
});

describe('readBooleanFlag', () => {
  it('returns true when flag is boolean true', () => {
    expect(readBooleanFlag({ flag: true }, 'flag')).toBe(true);
  });

  it('returns false when flag is a string value', () => {
    expect(readBooleanFlag({ flag: 'true' }, 'flag')).toBe(false);
  });

  it('returns false when key is missing', () => {
    expect(readBooleanFlag({}, 'flag')).toBe(false);
  });
});

describe('resolveFrontierUseLlm', () => {
  it('defaults dry-run frontier selection to deterministic mode', () => {
    expect(resolveFrontierUseLlm({}, true, true)).toBe(false);
  });

  it('uses the configured default for non-dry-run frontier selection', () => {
    expect(resolveFrontierUseLlm({}, false, true)).toBe(true);
    expect(resolveFrontierUseLlm({}, false, false)).toBe(false);
  });

  it('allows explicit frontier LLM overrides', () => {
    expect(resolveFrontierUseLlm({ 'use-llm': true }, true, false)).toBe(true);
    expect(resolveFrontierUseLlm({ 'no-llm': true }, false, true)).toBe(false);
  });

  it('rejects conflicting frontier LLM flags', () => {
    expect(() => resolveFrontierUseLlm({ 'use-llm': true, 'no-llm': true }, true, true)).toThrow(
      '--use-llm and --no-llm cannot be used together',
    );
  });
});
