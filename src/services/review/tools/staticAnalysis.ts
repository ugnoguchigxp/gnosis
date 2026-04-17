import { runStaticAnalysisByKind } from '../static/runner.js';
import type { ReviewerToolEntry } from './types.js';

export const runTypecheckToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'run_typecheck',
    description: 'TypeScript の型チェックを実行します。',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '対象ファイルのリスト（省略時は全件）',
        },
      },
    },
  },
  async handler(args, ctx) {
    const files = Array.isArray(args.files) ? (args.files as string[]) : [];
    try {
      // In Stage E, we might want to extend runner.ts to support 'kind'
      // Or just call the default runStaticAnalysis if kind is not yet implemented
      const result = await runStaticAnalysisByKind('typecheck', files, ctx.repoPath);
      if (result.degraded) {
        return '[Warning]: Typecheck unavailable or timed out.';
      }
      if (result.findings.length === 0) {
        return 'No type errors found.';
      }
      return JSON.stringify(result.findings, null, 2);
    } catch (error) {
      return `[Error running typecheck]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

export const runLintToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'run_lint',
    description: '静的解析 (ESLint/Linter) を実行します。',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '対象ファイルのリスト（省略時は全件）',
        },
      },
    },
  },
  async handler(args, ctx) {
    const files = Array.isArray(args.files) ? (args.files as string[]) : [];
    try {
      const result = await runStaticAnalysisByKind('lint', files, ctx.repoPath);
      if (result.degraded) {
        return '[Warning]: Linter unavailable or timed out.';
      }
      if (result.findings.length === 0) {
        return 'No lint errors found.';
      }
      return JSON.stringify(result.findings, null, 2);
    } catch (error) {
      return `[Error running lint]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
