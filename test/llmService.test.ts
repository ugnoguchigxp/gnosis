import { describe, expect, it } from 'bun:test';
import type { SpawnSyncResult } from '../src/services/llm';
import {
  distillKnowledgeFromTranscript,
  extractEntitiesFromText,
  judgeAndMergeEntities,
  summarizeCommunity,
} from '../src/services/llm';

const makeSpawnSync =
  (stdout: string, exitCode = 0) =>
  (): SpawnSyncResult => ({
    stdout,
    stderr: '',
    status: exitCode,
    error: undefined,
  });

const failingSpawnSync = (): SpawnSyncResult => ({
  stdout: '',
  stderr: 'command failed',
  status: 1,
  error: undefined,
});

const noLock = async <T>(_name: string, fn: () => Promise<T>) => fn();

const testDeps = { llmScript: 'mock-llm', llmTimeoutMs: 1000, withLock: noLock };

describe('llm service (legacy local LLM)', () => {
  describe('extractEntitiesFromText', () => {
    it('parses valid entity JSON from LLM output', async () => {
      const spawnSync = makeSpawnSync('[{"name":"Alice","type":"Person","description":"主人公"}]');
      const result = await extractEntitiesFromText('Alice is a person.', {
        ...testDeps,
        spawnSync,
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('Alice');
      expect(result[0]?.type).toBe('Person');
    });

    it('returns empty array when LLM exits with non-zero code', async () => {
      const result = await extractEntitiesFromText('some text', {
        ...testDeps,
        spawnSync: failingSpawnSync,
      });
      expect(result).toEqual([]);
    });

    it('returns empty array when LLM output has no JSON array', async () => {
      const spawnSync = makeSpawnSync('Sorry, I cannot help with that.');
      const result = await extractEntitiesFromText('text', { ...testDeps, spawnSync });
      expect(result).toEqual([]);
    });

    it('returns empty array when LLM output is empty', async () => {
      const spawnSync = makeSpawnSync('');
      const result = await extractEntitiesFromText('text', { ...testDeps, spawnSync });
      expect(result).toEqual([]);
    });
  });

  describe('summarizeCommunity', () => {
    it('parses community summary from LLM output', async () => {
      const spawnSync = makeSpawnSync(
        'Name: 日本の地理\nSummary: 日本の主要都市と地形に関する知識群',
      );
      const result = await summarizeCommunity('Entities: Tokyo, Osaka', {
        ...testDeps,
        spawnSync,
      });
      expect(result.name).toBe('日本の地理');
      expect(result.summary).toContain('日本');
    });

    it('returns fallback on empty output', async () => {
      const result = await summarizeCommunity('context', {
        ...testDeps,
        spawnSync: makeSpawnSync(''),
      });
      expect(result.name).toBe('Unknown Community');
    });

    it('supports plain text fallback when output has no labels', async () => {
      const result = await summarizeCommunity('context', {
        ...testDeps,
        spawnSync: makeSpawnSync('no json here'),
      });
      expect(result.name).toBe('no json here');
    });
  });

  describe('judgeAndMergeEntities', () => {
    const entityA = { name: 'Tokyo', type: 'City', description: '日本の首都' };
    const entityB = { name: '東京', type: 'City', description: 'Japan capital' };

    it('returns shouldMerge: true when LLM says merge', async () => {
      const spawnSync = makeSpawnSync(
        '{"shouldMerge":true,"merged":{"name":"Tokyo","type":"City","description":"日本の首都"}}',
      );
      const result = await judgeAndMergeEntities(entityA, entityB, { ...testDeps, spawnSync });
      expect(result.shouldMerge).toBe(true);
      expect(result.merged?.name).toBe('Tokyo');
    });

    it('returns shouldMerge: false when LLM says do not merge', async () => {
      const spawnSync = makeSpawnSync('{"shouldMerge":false}');
      const result = await judgeAndMergeEntities(entityA, entityB, { ...testDeps, spawnSync });
      expect(result.shouldMerge).toBe(false);
    });

    it('returns shouldMerge: false when LLM output has no JSON', async () => {
      const result = await judgeAndMergeEntities(entityA, entityB, {
        ...testDeps,
        spawnSync: makeSpawnSync(''),
      });
      expect(result.shouldMerge).toBe(false);
    });
  });

  describe('distillKnowledgeFromTranscript', () => {
    it('parses plain text distilled knowledge from LLM output', async () => {
      const spawnSync = makeSpawnSync('- Bun is fast\n- Use bun run for scripts');
      const result = await distillKnowledgeFromTranscript('transcript text', {
        ...testDeps,
        spawnSync,
      });
      expect(result.memories).toContain('- Bun is fast');
      expect(result.memories).toContain('- Use bun run for scripts');
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });

    it('throws when LLM exits non-zero', async () => {
      await expect(
        distillKnowledgeFromTranscript('transcript', { ...testDeps, spawnSync: failingSpawnSync }),
      ).rejects.toThrow();
    });

    it('throws when LLM output is empty', async () => {
      await expect(
        distillKnowledgeFromTranscript('transcript', {
          ...testDeps,
          spawnSync: makeSpawnSync(''),
        }),
      ).rejects.toThrow('Empty LLM response');
    });

    it('accepts non-JSON output as plain text memories', async () => {
      const result = await distillKnowledgeFromTranscript('transcript', {
        ...testDeps,
        spawnSync: makeSpawnSync('no json'),
      });
      expect(result.memories).toContain('no json');
    });
  });
});
