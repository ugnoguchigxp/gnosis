import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  type BudgetConfig,
  BudgetConfigSchema,
  type LlmClientConfig,
  LlmClientConfigSchema,
} from '../../../config.js';

const parseScalar = (raw: string): unknown => {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  throw new Error(`Unsupported TOML value: ${value}`);
};

const ensureRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`TOML path ${path} is not an object`);
  }
  return value as Record<string, unknown>;
};

const parseSimpleToml = (text: string): Record<string, unknown> => {
  const root: Record<string, unknown> = {};
  let sectionPath: string[] = [];

  const lines = text.split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const original = lines[lineNumber]?.trim() ?? '';
    if (!original || original.startsWith('#')) {
      continue;
    }

    const line = original.replace(/\s+#.*$/, '').trim();
    if (!line) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      const section = line.slice(1, -1).trim();
      if (!section) {
        throw new Error(`Invalid TOML section at line ${lineNumber + 1}`);
      }
      sectionPath = section.split('.').map((part) => part.trim());
      if (sectionPath.some((part) => part.length === 0)) {
        throw new Error(`Invalid TOML section path at line ${lineNumber + 1}`);
      }

      let cursor: Record<string, unknown> = root;
      for (const part of sectionPath) {
        const next = cursor[part];
        if (next === undefined) {
          cursor[part] = {};
        } else if (typeof next !== 'object' || next === null || Array.isArray(next)) {
          throw new Error(`Invalid TOML section collision: ${section}`);
        }
        cursor = ensureRecord(cursor[part], section);
      }
      continue;
    }

    const separator = line.indexOf('=');
    if (separator < 0) {
      throw new Error(`Invalid TOML key-value at line ${lineNumber + 1}`);
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!key || !rawValue) {
      throw new Error(`Invalid TOML key-value at line ${lineNumber + 1}`);
    }

    let cursor: Record<string, unknown> = root;
    for (const part of sectionPath) {
      const next = cursor[part];
      if (next === undefined) {
        cursor[part] = {};
      }
      cursor = ensureRecord(cursor[part], sectionPath.join('.'));
    }
    cursor[key] = parseScalar(rawValue);
  }

  return root;
};

const ProfileSchema = z
  .object({
    localLlmPath: z.string().min(1).optional(),
    knowflow: z
      .object({
        llm: LlmClientConfigSchema.partial().optional(),
        budget: BudgetConfigSchema.partial().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type KnowflowProfile = z.infer<typeof ProfileSchema>;

export const resolveProfilePath = (input: string, cwd = process.cwd()): string => {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('--profile must not be empty');
  }
  if (trimmed.includes('/') || trimmed.endsWith('.toml') || isAbsolute(trimmed)) {
    return resolve(cwd, trimmed);
  }
  return resolve(cwd, 'profiles', `${trimmed}.toml`);
};

export const loadKnowflowProfile = async (
  profileInput: string | undefined,
  cwd = process.cwd(),
): Promise<{ path: string; profile: KnowflowProfile } | null> => {
  if (!profileInput) {
    return null;
  }
  const path = resolveProfilePath(profileInput, cwd);
  const text = await readFile(path, 'utf-8');
  const parsed = parseSimpleToml(text);
  const profile = ProfileSchema.parse(parsed);
  return { path, profile };
};

export const mergeLlmConfig = (
  base: LlmClientConfig,
  override?: Partial<LlmClientConfig>,
): LlmClientConfig => {
  if (!override) return base;
  return LlmClientConfigSchema.parse({
    ...base,
    ...override,
  });
};

export const mergeBudgetConfig = (
  base: BudgetConfig,
  override?: Partial<BudgetConfig>,
): BudgetConfig => {
  if (!override) return base;
  return BudgetConfigSchema.parse({
    ...base,
    ...override,
  });
};
