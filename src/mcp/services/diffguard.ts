import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpHostService, McpHostToolResult } from '../hostProtocol.js';
import { diffGuardInputSchemaToJsonSchema } from './schema.js';

type DiffGuardToolDefinition = {
  name: string;
  title?: string;
  description?: string;
};

type DiffGuardService = {
  metadata: {
    name: string;
    version: string;
  };
  tools: DiffGuardToolDefinition[];
  callTool: (name: string, args: unknown) => Promise<McpHostToolResult>;
};

type DiffGuardServiceModule = {
  createDiffGuardMcpService: (options?: {
    defaultWorkspaceRoot?: string;
    requireWorkspaceRoot?: boolean;
  }) => DiffGuardService;
};

function resolveDiffGuardRepoPath(rootDir: string): string {
  return resolve(process.env.DIFFGUARD_REPO_PATH ?? join(rootDir, '..', 'diffGuard'));
}

async function importDiffGuardService(rootDir: string): Promise<{
  module: DiffGuardServiceModule;
  repoPath: string;
}> {
  const repoPath = resolveDiffGuardRepoPath(rootDir);
  const sourceEntrypoint = join(repoPath, 'src', 'mcp', 'service.ts');
  const distEntrypoint = join(repoPath, 'dist', 'mcp', 'service.js');
  const entrypoint = existsSync(sourceEntrypoint) ? sourceEntrypoint : distEntrypoint;
  const module = (await import(pathToFileURL(entrypoint).href)) as DiffGuardServiceModule;
  return { module, repoPath };
}

export async function createDiffGuardHostService(rootDir: string): Promise<McpHostService> {
  const { module, repoPath } = await importDiffGuardService(rootDir);
  const service = module.createDiffGuardMcpService({
    defaultWorkspaceRoot: repoPath,
    requireWorkspaceRoot: false,
  });

  return {
    name: service.metadata.name,
    version: service.metadata.version,
    listTools: () =>
      service.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: diffGuardInputSchemaToJsonSchema(tool.name),
      })),
    callTool: (name, args) => service.callTool(name, args),
  };
}
