import path from 'node:path';
import { classifyFile as classifyFromDiff } from '../diff/normalizer.js';
import type { FileClassification } from '../types.js';

export type { FileClassification } from '../types.js';

export function detectLanguage(filePath: string): string {
  return classifyFromDiff(filePath).language;
}

export function detectFramework(filePath: string): string | undefined {
  const basename = path.basename(filePath).toLowerCase();
  if (basename.includes('svelte')) return 'Svelte';
  if (basename.includes('next')) return 'Next.js';
  return undefined;
}

export function classifyFile(filePath: string): FileClassification {
  return {
    ...classifyFromDiff(filePath),
    framework: detectFramework(filePath),
  };
}
