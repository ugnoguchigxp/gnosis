import fs from 'node:fs/promises';
import path from 'node:path';
import type { ReviewerToolEntry } from './types.js';

export const getSymbolsToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'get_symbols',
    description:
      'ファイル内のトップレベルシンボル（関数、クラス、インターフェース等）の一覧を取得します。',
    inputSchema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'リポジトリルートからの相対パス' },
      },
    },
  },
  async handler(args, ctx) {
    const filePath = String(args.file_path);
    const fullPath = path.resolve(ctx.repoPath, filePath);

    try {
      const content = await fs.readFile(fullPath, 'utf8');
      const lines = content.split('\n');

      const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
      const interfacePattern = /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/;
      const classPattern = /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/;
      const typeAliasPattern = /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/;
      const enumPattern = /(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/;
      const variablePattern = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/;

      const symbols: Array<{ name: string; kind: string; line: number }> = [];

      lines.forEach((line, i) => {
        const patterns: Array<[RegExp, string]> = [
          [functionPattern, 'function'],
          [interfacePattern, 'interface'],
          [classPattern, 'class'],
          [typeAliasPattern, 'type_alias'],
          [enumPattern, 'enum'],
          [variablePattern, 'variable'],
        ];

        for (const [pattern, kind] of patterns) {
          const match = line.match(pattern);
          if (match?.[1]) {
            symbols.push({ name: match[1], kind, line: i + 1 });
            break;
          }
        }
      });

      if (symbols.length === 0) {
        return `No top-level symbols found in ${filePath}.`;
      }

      const output = symbols.map((s) => `- [${s.kind}] ${s.name} (Line ${s.line})`).join('\n');
      return `Symbols in ${filePath}:\n\n${output}`;
    } catch (error) {
      return `[Error getting symbols]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
