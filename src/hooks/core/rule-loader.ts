import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { type HookRule, HookRuleSchema, HookRulesDocumentSchema } from './hook-types.js';

async function collectRuleFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      const ext = extname(entry.name).toLowerCase();
      if (ext === '.yaml' || ext === '.yml') {
        files.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function parseRuleDocument(raw: string, filePath: string): HookRule[] {
  const parsed = YAML.parse(raw);

  const listCandidate = HookRulesDocumentSchema.safeParse(parsed);
  if (listCandidate.success) {
    return listCandidate.data.hooks;
  }

  const singleRule = HookRuleSchema.safeParse(parsed);
  if (singleRule.success) {
    return [singleRule.data];
  }

  const listError = listCandidate.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  const singleError = singleRule.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

  throw new Error(
    `Invalid hook rule document: ${filePath}\n[hooks[] schema]\n${listError.join(
      '\n',
    )}\n[single rule schema]\n${singleError.join('\n')}`,
  );
}

export async function loadHookRulesFromDirectory(rootDir: string): Promise<HookRule[]> {
  const resolvedRoot = resolve(rootDir);
  const files = await collectRuleFiles(resolvedRoot);
  const loaded: HookRule[] = [];

  for (const filePath of files) {
    const content = await readFile(filePath, 'utf8');
    const rules = parseRuleDocument(content, filePath);
    loaded.push(...rules);
  }

  return loaded;
}
