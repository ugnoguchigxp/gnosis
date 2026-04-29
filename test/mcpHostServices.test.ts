import { describe, expect, it } from 'bun:test';
import { createMcpHostRouter, createMcpHostServices } from '../src/mcp/services/index.js';

describe('MCP host services', () => {
  it('loads Gnosis, Astmend, and diffGuard tools into one router', async () => {
    const router = createMcpHostRouter(await createMcpHostServices(process.cwd()));
    const serviceNames = router.serviceNames();
    const toolNames = router.listTools().map((tool) => tool.name);

    expect(serviceNames).toContain('gnosis-memory-kg');
    expect(serviceNames).toContain('astmend-mcp');
    expect(serviceNames).toContain('diffguard-mcp');
    expect(toolNames).toContain('initial_instructions');
    expect(toolNames).toContain('analyze_references_from_text');
    expect(toolNames).toContain('analyze_diff');
  });

  it('routes Astmend and diffGuard tool calls through the host router', async () => {
    const router = createMcpHostRouter(await createMcpHostServices(process.cwd()));

    const astmend = await router.callTool('analyze_references_from_text', {
      sourceText: 'function hello() { return 1; } hello();',
      target: { kind: 'function', name: 'hello' },
    });
    const diffguard = await router.callTool('analyze_diff', {
      diff: [
        'diff --git a/a.ts b/a.ts',
        'index 1111111..2222222 100644',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1 @@',
        '-const a = 1;',
        '+const a = 2;',
        '',
      ].join('\n'),
    });

    expect(astmend.isError).not.toBe(true);
    expect(astmend.content[0]?.text).toContain('hello');
    expect(diffguard.isError).not.toBe(true);
    expect(diffguard.structuredContent).toBeDefined();
  });
});
