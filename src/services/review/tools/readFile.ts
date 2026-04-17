import fs from 'node:fs/promises';
import path from 'node:path';
import { REVIEW_LIMITS } from '../errors.js';
import type { ReviewerToolEntry } from './types.js';

const MAX_TOOL_FILE_LINES = 200;

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export const readFileToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'read_file',
    description: 'リポジトリ内のファイル内容を取得します。行範囲を指定できます。',
    inputSchema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'リポジトリルートからの相対パス' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
    },
  },
  async handler(args, ctx) {
    const filePath = String(args.file_path);
    const fullPath = path.resolve(ctx.repoPath, filePath);

    if (!isPathInside(fullPath, ctx.repoPath)) {
      return '[Error]: Access denied. Path must be inside the repository.';
    }

    try {
      const content = await fs.readFile(fullPath, 'utf8');
      const lines = content.split('\n');

      const start = Number(args.start_line ?? 1);
      const end = Number(args.end_line ?? lines.length);

      const sliced = lines.slice(start - 1, Math.min(end, start - 1 + MAX_TOOL_FILE_LINES));
      const output = sliced.map((l, i) => `${start + i}: ${l}`).join('\n');

      return `File: ${filePath} (Lines ${start}-${start + sliced.length - 1})\n\n${output}`;
    } catch (error) {
      return `[Error reading file]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

export const listDirToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'list_dir',
    description: 'ディレクトリ内のファイル一覧を取得します。',
    inputSchema: {
      type: 'object',
      required: ['dir_path'],
      properties: {
        dir_path: { type: 'string', description: 'リポジトリルートからの相対パス (ルートは ".")' },
      },
    },
  },
  async handler(args, ctx) {
    const dirPath = String(args.dir_path);
    const fullPath = path.resolve(ctx.repoPath, dirPath);

    if (!isPathInside(fullPath, ctx.repoPath) && fullPath !== ctx.repoPath) {
      return '[Error]: Access denied. Path must be inside the repository.';
    }

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const list = entries.map((e) => `${e.isDirectory() ? '[D]' : '[F]'} ${e.name}`).join('\n');
      return `Directory: ${dirPath}\n\n${list}`;
    } catch (error) {
      return `[Error reading directory]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
