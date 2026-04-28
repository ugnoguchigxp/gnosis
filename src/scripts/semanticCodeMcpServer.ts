#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import ts from 'typescript';
import { RuntimeLifecycle } from '../runtime/lifecycle.js';
import { registerProcess } from '../runtime/processRegistry.js';

export type JsonObject = Record<string, unknown>;

export type SymbolInfo = {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  namePath: string;
};

export type SemanticContext = {
  rootDir: string;
  runRg?: (args: string[], rootDir: string) => string;
};

type RgJsonMatchLine = {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
};

const DEFAULT_CONTEXT: SemanticContext = {
  rootDir: process.cwd(),
};

export const TOOL_DEFINITIONS = [
  {
    name: 'semantic_list_files',
    description:
      'List project files using ripgrep. Supports optional filename query and glob filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional substring filter for filenames.' },
        glob: { type: 'string', description: 'Optional rg glob filter, e.g. "**/*.ts".' },
        limit: { type: 'number', description: 'Max returned files (default: 200).' },
      },
    },
  },
  {
    name: 'semantic_search_pattern',
    description:
      'Search text pattern in project files using ripgrep and return line-level matches.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern for ripgrep search.' },
        glob: { type: 'string', description: 'Optional rg glob filter, e.g. "**/*.ts".' },
        limit: { type: 'number', description: 'Max returned matches (default: 100).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'semantic_get_symbols_overview',
    description:
      'Parse a TS/JS file and return symbol overview (functions, classes, interfaces, types, enums, methods, variables).',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to a source file (relative or absolute).' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'semantic_find_symbol',
    description:
      'Find symbol definitions by exact name across TS/JS files. Optionally filter by kind and glob.',
    inputSchema: {
      type: 'object',
      properties: {
        symbolName: { type: 'string', description: 'Exact symbol name to find.' },
        kind: {
          type: 'string',
          description:
            'Optional symbol kind filter (function, class, interface, type_alias, enum, method, variable).',
        },
        glob: { type: 'string', description: 'Optional rg glob filter, e.g. "**/*.ts".' },
        limit: { type: 'number', description: 'Max returned symbols (default: 50).' },
      },
      required: ['symbolName'],
    },
  },
  {
    name: 'semantic_read_symbol',
    description:
      'Read a symbol body from a file by exact name. Useful for targeted context without reading full file.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to a source file.' },
        symbolName: { type: 'string', description: 'Exact symbol name.' },
        occurrence: {
          type: 'number',
          description:
            '1-based occurrence index when multiple symbols share same name (default: 1).',
        },
      },
      required: ['filePath', 'symbolName'],
    },
  },
  {
    name: 'semantic_find_references',
    description:
      'Find textual references of a symbol name across project files (word boundary based).',
    inputSchema: {
      type: 'object',
      properties: {
        symbolName: { type: 'string', description: 'Symbol name to search references for.' },
        glob: { type: 'string', description: 'Optional rg glob filter.' },
        limit: { type: 'number', description: 'Max returned references (default: 100).' },
      },
      required: ['symbolName'],
    },
  },
  {
    name: 'semantic_read_file',
    description: 'Read the full content of a file.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file to read.' },
      },
      required: ['filePath'],
    },
  },
] as const;

function clampLimit(value: unknown, fallback: number, max = 1000): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function getStringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveWithinRoot(context: SemanticContext, inputPath: string): string {
  const rootAbs = path.resolve(context.rootDir);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootAbs, inputPath);
  const rel = path.relative(rootAbs, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside project root: ${inputPath}`);
  }

  // Guard against symlink traversal: a path under root may still point outside via symlink.
  if (fs.existsSync(resolved)) {
    const rootReal = fs.realpathSync.native(rootAbs);
    const resolvedReal = fs.realpathSync.native(resolved);
    const realRel = path.relative(rootReal, resolvedReal);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`Path is outside project root (symlink): ${inputPath}`);
    }
  }

  return resolved;
}

function executeRg(args: string[], rootDir: string): string {
  const result = spawnSync('rg', args, {
    cwd: rootDir,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Failed to execute rg: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(`rg failed (status=${result.status}): ${stderr}`);
  }
  return result.stdout ?? '';
}

function runRg(context: SemanticContext, args: string[]): string {
  if (context.runRg) {
    return context.runRg(args, context.rootDir);
  }
  return executeRg(args, context.rootDir);
}

function parseScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function declarationName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && node.name) {
    if (ts.isIdentifier(node.name)) return node.name.text;
    if (ts.isStringLiteral(node.name)) return node.name.text;
  }

  return null;
}

function symbolKind(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type_alias';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isMethodDeclaration(node)) return 'method';
  if (ts.isVariableDeclaration(node)) return 'variable';
  return null;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!('modifiers' in node)) return false;
  const mods = (node as ts.HasModifiers).modifiers;
  if (!mods) return false;
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isExported(node: ts.Node): boolean {
  if (hasExportModifier(node)) return true;

  // Variable declarations don't carry `export` on the declaration node itself.
  if (ts.isVariableDeclaration(node)) {
    const declList = node.parent;
    if (declList && ts.isVariableDeclarationList(declList)) {
      const statement = declList.parent;
      if (statement && ts.isVariableStatement(statement)) {
        return hasExportModifier(statement);
      }
    }
  }

  return false;
}

function collectSymbols(context: SemanticContext, filePath: string): SymbolInfo[] {
  const abs = resolveWithinRoot(context, filePath);
  const content = fs.readFileSync(abs, 'utf-8');
  const kind = parseScriptKind(abs);
  if (kind === ts.ScriptKind.Unknown) {
    return [];
  }

  const sourceFile = ts.createSourceFile(abs, content, ts.ScriptTarget.Latest, true, kind);
  const result: SymbolInfo[] = [];

  const pushSymbol = (node: ts.Node, parentPath?: string): void => {
    const name = declarationName(node);
    const kindName = symbolKind(node);
    if (!name || !kindName) return;

    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const namePath = parentPath ? `${parentPath}/${name}` : name;

    result.push({
      name,
      kind: kindName,
      startLine: start,
      endLine: end,
      exported: isExported(node),
      namePath,
    });
  };

  const visit = (node: ts.Node, parentPath?: string): void => {
    const currentKind = symbolKind(node);
    const currentName = declarationName(node);
    const nextPath =
      currentKind && currentName
        ? parentPath
          ? `${parentPath}/${currentName}`
          : currentName
        : parentPath;

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isVariableDeclaration(node)
    ) {
      pushSymbol(node, parentPath);
    }

    ts.forEachChild(node, (child) => visit(child, nextPath));
  };

  visit(sourceFile, undefined);
  return result;
}

function readFileLines(context: SemanticContext, filePath: string): string[] {
  const abs = resolveWithinRoot(context, filePath);
  return fs.readFileSync(abs, 'utf-8').split(/\r?\n/);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRgJsonLine(line: string): RgJsonMatchLine | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as RgJsonMatchLine;
  } catch {
    return null;
  }
}

export function listProjectFiles(
  args: JsonObject,
  context: SemanticContext = DEFAULT_CONTEXT,
): string {
  const query = getStringArg(args, 'query')?.toLowerCase();
  const glob = getStringArg(args, 'glob');
  const limit = clampLimit(args.limit, 200, 5000);

  const rgArgs = ['--files'];
  if (glob) {
    rgArgs.push('-g', glob);
  }

  const stdout = runRg(context, rgArgs);
  const files = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => (query ? file.toLowerCase().includes(query) : true))
    .slice(0, limit);

  return JSON.stringify({ total: files.length, files }, null, 2);
}

export function searchPattern(
  args: JsonObject,
  context: SemanticContext = DEFAULT_CONTEXT,
): string {
  const pattern = getStringArg(args, 'pattern');
  if (!pattern) throw new Error('pattern is required');
  const glob = getStringArg(args, 'glob');
  const limit = clampLimit(args.limit, 100, 2000);

  const rgArgs = ['--json', '-n', '-S', pattern];
  if (glob) {
    rgArgs.push('-g', glob);
  }

  const stdout = runRg(context, rgArgs);
  const matches: Array<{ filePath: string; line: number; text: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseRgJsonLine(line);
    if (!parsed) continue;
    if (parsed?.type !== 'match') continue;

    const filePath = parsed?.data?.path?.text as string | undefined;
    const lineNo = parsed?.data?.line_number as number | undefined;
    const text = (parsed?.data?.lines?.text as string | undefined)?.replace(/\n$/, '');
    if (!filePath || typeof lineNo !== 'number' || text === undefined) continue;

    matches.push({ filePath, line: lineNo, text });
    if (matches.length >= limit) break;
  }

  return JSON.stringify({ total: matches.length, matches }, null, 2);
}

export function getSymbolsOverview(
  args: JsonObject,
  context: SemanticContext = DEFAULT_CONTEXT,
): string {
  const filePath = getStringArg(args, 'filePath');
  if (!filePath) throw new Error('filePath is required');

  const symbols = collectSymbols(context, filePath);
  return JSON.stringify({ filePath, total: symbols.length, symbols }, null, 2);
}

export function findSymbol(args: JsonObject, context: SemanticContext = DEFAULT_CONTEXT): string {
  const symbolName = getStringArg(args, 'symbolName');
  if (!symbolName) throw new Error('symbolName is required');
  const kindFilter = getStringArg(args, 'kind');
  const glob = getStringArg(args, 'glob');
  const limit = clampLimit(args.limit, 50, 500);

  const regex = `\\b${escapeRegex(symbolName)}\\b`;
  const rgArgs = ['-l', '-S', regex];
  if (glob) rgArgs.push('-g', glob);
  if (!glob) {
    rgArgs.push(
      '-g',
      '**/*.ts',
      '-g',
      '**/*.tsx',
      '-g',
      '**/*.js',
      '-g',
      '**/*.jsx',
      '-g',
      '**/*.mts',
      '-g',
      '**/*.cts',
    );
  }

  const fileCandidates = runRg(context, rgArgs)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 500);

  const found: Array<SymbolInfo & { filePath: string }> = [];
  for (const filePath of fileCandidates) {
    const symbols = collectSymbols(context, filePath);
    for (const symbol of symbols) {
      if (symbol.name !== symbolName) continue;
      if (kindFilter && symbol.kind !== kindFilter) continue;
      found.push({ ...symbol, filePath });
      if (found.length >= limit) break;
    }
    if (found.length >= limit) break;
  }

  return JSON.stringify({ total: found.length, symbols: found }, null, 2);
}

export function readSymbol(args: JsonObject, context: SemanticContext = DEFAULT_CONTEXT): string {
  const filePath = getStringArg(args, 'filePath');
  const symbolName = getStringArg(args, 'symbolName');
  if (!filePath || !symbolName) throw new Error('filePath and symbolName are required');

  const occurrence = clampLimit(args.occurrence, 1, 1000);
  const symbols = collectSymbols(context, filePath).filter((symbol) => symbol.name === symbolName);
  if (symbols.length === 0) {
    return JSON.stringify({ found: false, reason: 'symbol not found' }, null, 2);
  }

  const index = Math.max(0, occurrence - 1);
  const target = symbols[index] ?? symbols[0];
  const lines = readFileLines(context, filePath);
  const snippet = lines.slice(target.startLine - 1, target.endLine).join('\n');

  return JSON.stringify(
    {
      found: true,
      filePath,
      symbol: target,
      snippet,
    },
    null,
    2,
  );
}

export function findReferences(
  args: JsonObject,
  context: SemanticContext = DEFAULT_CONTEXT,
): string {
  const symbolName = getStringArg(args, 'symbolName');
  if (!symbolName) throw new Error('symbolName is required');
  const glob = getStringArg(args, 'glob');
  const limit = clampLimit(args.limit, 100, 2000);

  const regex = `\\b${escapeRegex(symbolName)}\\b`;
  const rgArgs = ['--json', '-n', '-S', regex];
  if (glob) {
    rgArgs.push('-g', glob);
  }

  const stdout = runRg(context, rgArgs);
  const refs: Array<{ filePath: string; line: number; text: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseRgJsonLine(line);
    if (!parsed) continue;
    if (parsed?.type !== 'match') continue;

    const filePath = parsed?.data?.path?.text as string | undefined;
    const lineNo = parsed?.data?.line_number as number | undefined;
    const text = (parsed?.data?.lines?.text as string | undefined)?.replace(/\n$/, '');
    if (!filePath || typeof lineNo !== 'number' || text === undefined) continue;

    refs.push({ filePath, line: lineNo, text });
    if (refs.length >= limit) break;
  }

  return JSON.stringify({ total: refs.length, references: refs }, null, 2);
}

export function readFile(args: JsonObject, context: SemanticContext = DEFAULT_CONTEXT): string {
  const filePath = getStringArg(args, 'filePath');
  if (!filePath) throw new Error('filePath is required');

  const abs = resolveWithinRoot(context, filePath);
  if (!fs.existsSync(abs)) {
    return JSON.stringify({ error: `File not found: ${filePath}` });
  }
  const content = fs.readFileSync(abs, 'utf-8');
  return JSON.stringify({ filePath, content }, null, 2);
}

export function runSemanticTool(
  toolName: string,
  args: JsonObject,
  context: SemanticContext = DEFAULT_CONTEXT,
): string {
  switch (toolName) {
    case 'semantic_list_files':
      return listProjectFiles(args, context);
    case 'semantic_search_pattern':
      return searchPattern(args, context);
    case 'semantic_get_symbols_overview':
      return getSymbolsOverview(args, context);
    case 'semantic_find_symbol':
      return findSymbol(args, context);
    case 'semantic_read_symbol':
      return readSymbol(args, context);
    case 'semantic_find_references':
      return findReferences(args, context);
    case 'semantic_read_file':
      return readFile(args, context);

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

async function main(): Promise<void> {
  process.title = 'semantic-code-tools';
  const context: SemanticContext = {
    rootDir: process.env.GNOSIS_ROOT_DIR || process.cwd(),
  };
  console.error(
    `[Semantic] Starting server at ${context.rootDir} (env: ${
      process.env.GNOSIS_ROOT_DIR
    }, cwd: ${process.cwd()})`,
  );
  const server = new Server(
    { name: 'semantic-code-tools', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as JsonObject;

    try {
      const text = runSemanticTool(toolName, args, context);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
    }
  });

  const registration = registerProcess({ role: 'semantic-mcp', title: process.title });
  const lifecycle = new RuntimeLifecycle({ name: 'SemanticMcpServer', registration });
  lifecycle.addCleanupStep(() => registration.unregister());
  lifecycle.bindProcessEvents();
  lifecycle.startParentWatch();

  const transport = new StdioServerTransport();
  lifecycle.markRunning();
  lifecycle.startHeartbeat();
  (transport as unknown as { onclose?: () => void }).onclose = () => {
    void lifecycle.requestShutdown('transport_close');
  };
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
