import { describe, expect, it } from 'bun:test';
import {
  buildAgenticSearchTaskEnvelope,
  selectAgenticSearchPhrases,
} from '../src/services/agentFirst';

describe('agentFirst minimal utilities', () => {
  it('builds task envelope from MCP input', () => {
    const task = buildAgenticSearchTaskEnvelope({
      userRequest: 'Debug MCP host connection closed error in agentic search',
      intent: 'debug',
      files: ['src/mcp/tools/agentFirst.ts'],
      changeTypes: ['mcp', 'test'],
      technologies: ['typescript'],
    });

    expect(task.intent).toBe('debug');
    expect(task.tokens).toContain('debug');
    expect(task.files).toContain('src/mcp/tools/agentFirst.ts');
  });

  it('selects phrases for agenticSearch input', () => {
    const phrases = selectAgenticSearchPhrases({
      request: 'Refactor agentic search',
      intent: 'edit',
      repoPath: '/tmp/repo',
      files: ['src/services/agentFirst.ts'],
      changeTypes: ['mcp', 'refactor'],
      technologies: ['typescript'],
      tokens: ['agentic', 'search', 'refactor'],
    });

    expect(phrases).toContain('mcp');
    expect(phrases).toContain('typescript');
    expect(phrases.some((p) => p.includes('agentFirst.ts'))).toBe(true);
  });

  it('keeps selected phrases available for SystemContext evaluation', () => {
    const task = buildAgenticSearchTaskEnvelope({
      userRequest: 'Review agentic search fallback',
      changeTypes: ['mcp'],
      technologies: ['typescript'],
    });

    expect(selectAgenticSearchPhrases(task)).toContain('agentic');
  });
});
