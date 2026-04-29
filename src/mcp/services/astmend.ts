import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpHostService, McpHostToolResult } from '../hostProtocol.js';
import { zodInputSchemaToJsonSchema } from './schema.js';

type AstmendToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
};

type AstmendService = {
  name: string;
  version: string;
  tools: readonly AstmendToolDefinition[];
  callTool: (name: string, args: unknown) => Promise<McpHostToolResult>;
};

type AstmendServiceModule = {
  createAstmendMcpService: () => AstmendService;
};

function resolveAstmendRepoPath(rootDir: string): string {
  return resolve(process.env.ASTMEND_REPO_PATH ?? join(rootDir, '..', 'Astmend'));
}

async function importAstmendService(rootDir: string): Promise<AstmendServiceModule> {
  const repoPath = resolveAstmendRepoPath(rootDir);
  const sourceEntrypoint = join(repoPath, 'src', 'mcp', 'service.ts');
  const distEntrypoint = join(repoPath, 'dist', 'mcp', 'service.js');
  const entrypoint = existsSync(sourceEntrypoint) ? sourceEntrypoint : distEntrypoint;
  return (await import(pathToFileURL(entrypoint).href)) as AstmendServiceModule;
}

export async function createAstmendHostService(rootDir: string): Promise<McpHostService> {
  const module = await importAstmendService(rootDir);
  const service = module.createAstmendMcpService();

  return {
    name: service.name,
    version: service.version,
    listTools: () =>
      service.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: zodInputSchemaToJsonSchema(tool.inputSchema),
      })),
    callTool: (name, args) => service.callTool(name, args),
  };
}
