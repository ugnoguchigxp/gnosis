import path from 'node:path';
import parseDiff from 'parse-diff';
import type { FileClassification, Hunk, NormalizedDiff } from '../types.js';

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  if (ext === '.svelte') return 'svelte';
  return 'unknown';
}

export function classifyFile(filePath: string): FileClassification {
  const basename = path.basename(filePath);

  return {
    language: detectLanguage(filePath),
    isConfig:
      /(?:^|[./_-])(config|settings)\b/i.test(filePath) ||
      /\.(?:env|toml|ya?ml|json|ini)$/i.test(filePath),
    isMigration: /migration|migrate/i.test(filePath) || /\.(?:sql|prisma)$/i.test(filePath),
    isTest: /(?:\.|\/)(?:test|spec)\.[jt]sx?$/i.test(filePath) || /^test\//i.test(filePath),
    isInfra: /docker|terraform|ansible|k8s|kubernetes|helm/i.test(filePath),
    framework: /svelte/i.test(basename) ? 'Svelte' : undefined,
  };
}

function detectChangeType(file: Record<string, unknown>): NormalizedDiff['changeType'] {
  const filePath = String(file.to ?? file.from ?? '');
  if (file.binary === true) return 'modified';
  if (file.renamed === true || file.renamedTo || file.renamedFrom) return 'renamed';
  if (filePath === '/dev/null' || file.new === true || file.added === true) return 'added';
  if (file.deleted === true || filePath === '/dev/null') return 'deleted';
  return 'modified';
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function normalizeDiff(rawDiff: string): NormalizedDiff[] {
  const files = parseDiff(rawDiff) as unknown as Array<Record<string, unknown>>;

  return files.map((file) => {
    const chunks = Array.isArray(file.chunks) ? file.chunks : [];
    const hunks: Hunk[] = chunks.map((chunk) => {
      const changes = Array.isArray(chunk.changes) ? chunk.changes : [];
      return {
        oldStart: toNumber(chunk.oldStart),
        oldLines: toNumber(chunk.oldLines),
        newStart: toNumber(chunk.newStart),
        newLines: toNumber(chunk.newLines),
        lines: changes.map((change: Record<string, unknown>) => ({
          type: change.type === 'add' ? 'added' : change.type === 'del' ? 'removed' : 'context',
          oldLineNo:
            typeof change.ln1 === 'number'
              ? change.ln1
              : typeof change.ln === 'number'
                ? change.ln
                : undefined,
          newLineNo:
            typeof change.ln2 === 'number'
              ? change.ln2
              : typeof change.ln === 'number'
                ? change.ln
                : undefined,
          content: String(change.content ?? ''),
        })),
      };
    });

    const newLineMap = new Map<number, string>();
    const oldLineMap = new Map<number, string>();

    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.newLineNo !== undefined) newLineMap.set(line.newLineNo, line.content);
        if (line.oldLineNo !== undefined) oldLineMap.set(line.oldLineNo, line.content);
      }
    }

    const filePath = String(file.to ?? file.from ?? 'unknown');

    return {
      filePath,
      changeType: detectChangeType(file),
      oldLineMap,
      newLineMap,
      hunks,
      language: detectLanguage(filePath),
      fileSize: rawDiff.length,
      isBinary: file.binary === true,
      classification: classifyFile(filePath),
    };
  });
}

export function countAddedLines(diffs: NormalizedDiff[]): number {
  return diffs.reduce(
    (total, diff) =>
      total +
      diff.hunks.reduce(
        (sum, hunk) => sum + hunk.lines.filter((line) => line.type === 'added').length,
        0,
      ),
    0,
  );
}

export function countRemovedLines(diffs: NormalizedDiff[]): number {
  return diffs.reduce(
    (total, diff) =>
      total +
      diff.hunks.reduce(
        (sum, hunk) => sum + hunk.lines.filter((line) => line.type === 'removed').length,
        0,
      ),
    0,
  );
}

export function extractChangedFiles(diffs: NormalizedDiff[]): string[] {
  return [...new Set(diffs.map((diff) => diff.filePath))];
}
