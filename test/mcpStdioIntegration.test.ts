import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sendMcpHostRequest } from '../src/mcp/hostProtocol.js';

describe('MCP stdio integration', () => {
  let transport: StdioClientTransport | null = null;

  afterEach(async () => {
    if (transport) {
      await transport.close().catch(() => {});
      transport = null;
    }
    await sendMcpHostRequest({ type: 'shutdown' }, { timeoutMs: 500 }).catch(() => {});
  });

  it('starts the stdio server and calls initial_instructions', async () => {
    transport = new StdioClientTransport({
      command: process.argv[0] ?? 'bun',
      args: ['run', 'src/index.ts'],
      env: {
        ...process.env,
        GNOSIS_NO_WORKERS: 'true',
        GNOSIS_MCP_ADAPTER_IDLE_MS: '1000',
        GNOSIS_MCP_HOST_IDLE_EXIT_MS: '1000',
      },
    });
    const client = new Client(
      { name: 'gnosis-stdio-integration-test', version: '0.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    const tools = await client.listTools();
    const result = (await client.callTool({ name: 'initial_instructions', arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };

    expect(tools.tools.map((tool) => tool.name)).toContain('initial_instructions');
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    expect(
      result.content.some(
        (item) => item.type === 'text' && String(item.text).includes('activate_project'),
      ),
    ).toBe(true);
  });
});
