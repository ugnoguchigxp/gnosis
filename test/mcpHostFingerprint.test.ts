import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeMcpHostSourceFingerprint } from '../src/mcp/hostFingerprint.js';

function writeSource(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

describe('MCP host source fingerprint', () => {
  it('changes when Agent-First retrieval service code changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'gnosis-mcp-fingerprint-'));
    try {
      writeSource(root, 'package.json', '{"name":"test"}\n');
      writeSource(root, 'src/index.ts', 'export {};\n');
      writeSource(root, 'src/scripts/mcp-host.ts', 'export {};\n');
      writeSource(root, 'src/mcp/server.ts', 'export const mcp = 1;\n');
      writeSource(root, 'src/services/agentFirst.ts', 'export const version = 1;\n');
      writeSource(root, 'src/services/entityKnowledge.ts', 'export const version = 1;\n');

      const before = computeMcpHostSourceFingerprint(root);
      writeSource(root, 'src/services/agentFirst.ts', 'export const version = 2;\n');
      const afterAgentFirstChange = computeMcpHostSourceFingerprint(root);
      writeSource(root, 'src/services/entityKnowledge.ts', 'export const version = 2;\n');
      const afterEntitySearchChange = computeMcpHostSourceFingerprint(root);

      expect(afterAgentFirstChange).not.toBe(before);
      expect(afterEntitySearchChange).not.toBe(afterAgentFirstChange);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
