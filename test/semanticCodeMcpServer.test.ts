import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type SemanticContext,
  findReferences,
  findSymbol,
  getSymbolsOverview,
  listProjectFiles,
  readSymbol,
  runSemanticTool,
  searchPattern,
} from '../src/scripts/semanticCodeMcpServer.js';

let rootDir = '';
let context: SemanticContext;
let outsideDir = '';

const parseJson = <T>(text: string): T => JSON.parse(text) as T;

describe('semanticCodeMcpServer read-only tools', () => {
  beforeAll(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-semantic-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-semantic-outside-'));
    fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });

    fs.writeFileSync(
      path.join(rootDir, 'src', 'lib.ts'),
      [
        'export interface Greeter {',
        '  greet(name: string): string;',
        '}',
        '',
        'export function greet(name: string): string {',
        '  const message = `Hello ${name}`;',
        '  return message;',
        '}',
        '',
        "export const VERSION = '1.0.0';",
        '',
        'export class UserService {',
        '  getUser(id: string): string {',
        '    return greet(id);',
        '  }',
        '}',
      ].join('\n'),
      'utf-8',
    );

    fs.writeFileSync(
      path.join(rootDir, 'src', 'refs.ts'),
      [
        "import { greet } from './lib';",
        '',
        'export function run(): string {',
        "  return greet('Alice');",
        '}',
        '',
        "const v = greet('Bob');",
        'export { v };',
      ].join('\n'),
      'utf-8',
    );

    fs.writeFileSync(path.join(outsideDir, 'outside.ts'), 'export const outside = 1;\n', 'utf-8');

    // Symlink under project root that points outside root should be rejected.
    try {
      fs.symlinkSync(
        path.join(outsideDir, 'outside.ts'),
        path.join(rootDir, 'src', 'outside-link.ts'),
      );
    } catch {
      // Ignore if symlink cannot be created in this environment.
    }

    context = { rootDir };
  });

  afterAll(() => {
    if (rootDir && fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    if (outsideDir && fs.existsSync(outsideDir)) {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('lists files with glob and limit', () => {
    const result = parseJson<{ total: number; files: string[] }>(
      listProjectFiles({ glob: '**/*.ts', limit: 10 }, context),
    );

    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.files.some((f) => f.endsWith('src/lib.ts'))).toBe(true);
    expect(result.files.some((f) => f.endsWith('src/refs.ts'))).toBe(true);
  });

  test('searches pattern matches', () => {
    const result = parseJson<{ total: number; matches: Array<{ filePath: string; line: number }> }>(
      searchPattern({ pattern: 'greet\\(', glob: '**/*.ts', limit: 20 }, context),
    );

    expect(result.total).toBeGreaterThan(0);
    expect(result.matches.some((m) => m.filePath.endsWith('src/refs.ts'))).toBe(true);
  });

  test('returns symbols overview', () => {
    const result = parseJson<{
      total: number;
      symbols: Array<{ name: string; kind: string; exported: boolean }>;
    }>(getSymbolsOverview({ filePath: 'src/lib.ts' }, context));

    expect(result.total).toBeGreaterThan(0);
    expect(result.symbols.some((s) => s.name === 'Greeter' && s.kind === 'interface')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'greet' && s.kind === 'function')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'UserService' && s.kind === 'class')).toBe(true);
    expect(
      result.symbols.some((s) => s.name === 'VERSION' && s.kind === 'variable' && s.exported),
    ).toBe(true);
  });

  test('finds symbol definitions by exact name', () => {
    const result = parseJson<{
      total: number;
      symbols: Array<{ name: string; kind: string; filePath: string }>;
    }>(findSymbol({ symbolName: 'greet', kind: 'function', glob: '**/*.ts' }, context));

    expect(result.total).toBe(1);
    expect(result.symbols[0]?.filePath.endsWith('src/lib.ts')).toBe(true);
    expect(result.symbols[0]?.name).toBe('greet');
  });

  test('reads symbol body by name', () => {
    const result = parseJson<{ found: boolean; snippet?: string }>(
      readSymbol({ filePath: 'src/lib.ts', symbolName: 'greet' }, context),
    );

    expect(result.found).toBe(true);
    expect(result.snippet).toContain('const message = `Hello ${name}`;');
    expect(result.snippet).toContain('return message;');
  });

  test('returns not found for unknown symbol', () => {
    const result = parseJson<{ found: boolean; reason?: string }>(
      readSymbol({ filePath: 'src/lib.ts', symbolName: 'missingSymbol' }, context),
    );

    expect(result.found).toBe(false);
    expect(result.reason).toBe('symbol not found');
  });

  test('finds references of symbol name', () => {
    const result = parseJson<{
      total: number;
      references: Array<{ filePath: string; line: number; text: string }>;
    }>(findReferences({ symbolName: 'greet', glob: '**/*.ts', limit: 50 }, context));

    expect(result.total).toBeGreaterThan(1);
    expect(result.references.some((r) => r.filePath.endsWith('src/refs.ts'))).toBe(true);
  });

  test('blocks path traversal outside root', () => {
    expect(() => getSymbolsOverview({ filePath: '../outside.ts' }, context)).toThrow(
      'Path is outside project root',
    );
  });

  test('blocks symlink traversal outside root', () => {
    const symlinkPath = path.join(rootDir, 'src', 'outside-link.ts');
    if (!fs.existsSync(symlinkPath)) {
      return;
    }

    expect(() => getSymbolsOverview({ filePath: 'src/outside-link.ts' }, context)).toThrow(
      'Path is outside project root (symlink)',
    );
  });

  test('runSemanticTool returns structured error for unknown tool', () => {
    const result = parseJson<{ error: string }>(runSemanticTool('unknown_tool', {}, context));
    expect(result.error).toContain('Unknown tool');
  });
});
