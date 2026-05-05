import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_PATHS = [
  'package.json',
  'src/index.ts',
  'src/scripts/mcp-host.ts',
  'src/mcp',
  'src/services/agentFirst.ts',
  'src/services/agenticSearch',
  'src/services/entityKnowledge.ts',
  'src/services/failureFirewall',
  'src/services/review',
  'src/services/reviewAgent',
  'src/services/sessionKnowledge',
] as const;

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];

  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => collectFiles(join(path, entry.name)))
    .filter((file) => /\.(ts|tsx|js|json)$/.test(file))
    .sort();
}

export function computeMcpHostSourceFingerprint(rootDir = ROOT_DIR): string {
  const hash = createHash('sha256');
  for (const sourcePath of SOURCE_PATHS) {
    const absolutePath = resolve(rootDir, sourcePath);
    for (const file of collectFiles(absolutePath)) {
      hash.update(relative(rootDir, file));
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

export const MCP_HOST_SOURCE_FINGERPRINT = computeMcpHostSourceFingerprint();
