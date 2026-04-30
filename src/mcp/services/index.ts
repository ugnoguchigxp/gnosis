import type {
  McpHostCallOptions,
  McpHostService,
  McpHostTool,
  McpHostToolResult,
} from '../hostProtocol.js';
import { createGnosisMcpService } from '../server.js';
import { createAstmendHostService } from './astmend.js';
import { createDiffGuardHostService } from './diffguard.js';

export type McpHostRouter = {
  serviceNames: () => string[];
  listTools: () => McpHostTool[];
  callTool: (
    name: string,
    args: unknown,
    options?: McpHostCallOptions,
  ) => Promise<McpHostToolResult>;
};

function toErrorResult(message: string): McpHostToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

async function loadOptionalService(
  label: string,
  loader: () => Promise<McpHostService>,
): Promise<McpHostService | null> {
  try {
    return await loader();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[McpHost] ${label} service disabled: ${message}`);
    return null;
  }
}

export async function createMcpHostServices(rootDir: string): Promise<McpHostService[]> {
  const services: McpHostService[] = [createGnosisMcpService()];
  const astmend = await loadOptionalService('Astmend', () => createAstmendHostService(rootDir));
  const diffguard = await loadOptionalService('diffGuard', () =>
    createDiffGuardHostService(rootDir),
  );

  if (astmend) services.push(astmend);
  if (diffguard) services.push(diffguard);

  return services;
}

export function createMcpHostRouter(services: McpHostService[]): McpHostRouter {
  const toolOwner = new Map<string, McpHostService>();
  const tools: McpHostTool[] = [];

  for (const service of services) {
    for (const tool of service.listTools()) {
      const existing = toolOwner.get(tool.name);
      if (existing) {
        throw new Error(
          `Duplicate MCP tool name "${tool.name}" from ${existing.name} and ${service.name}`,
        );
      }
      toolOwner.set(tool.name, service);
      tools.push(tool);
    }
  }

  return {
    serviceNames: () => services.map((service) => service.name),
    listTools: () => tools,
    callTool: async (name, args, options) => {
      const service = toolOwner.get(name);
      if (!service) return toErrorResult(`Unknown tool: ${name}`);
      try {
        return await service.callTool(name, args, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toErrorResult(`[${service.name}] ${message}`);
      }
    },
  };
}
