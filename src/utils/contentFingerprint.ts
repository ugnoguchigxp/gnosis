import { sha256 } from './crypto.js';

export function normalizeContentForFingerprint(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .toLowerCase();
}

export function contentFingerprint(value: string): {
  contentHash: string;
  normalizedContentHash: string;
} {
  return {
    contentHash: sha256(value),
    normalizedContentHash: sha256(normalizeContentForFingerprint(value)),
  };
}
