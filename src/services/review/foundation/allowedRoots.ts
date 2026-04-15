import fs from 'node:fs';
import path from 'node:path';
import { ReviewError } from '../errors.js';

const isWithin = (base: string, target: string): boolean => {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

function resolveExistingPath(value: string, label: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    throw new ReviewError('E001', `Cannot resolve ${label}: ${value}`);
  }
}

function getAllowedRoots(): string[] {
  const allowedEnv = process.env.GNOSIS_ALLOWED_ROOTS;
  if (!allowedEnv?.trim()) {
    return [resolveExistingPath(process.cwd(), 'current working directory')];
  }

  return allowedEnv
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolveExistingPath(item, 'allowed root'));
}

export function validateAllowedRoot(projectRoot: string): void {
  const realRoot = resolveExistingPath(projectRoot, 'project root');
  const allowedRoots = getAllowedRoots();

  if (!allowedRoots.some((root) => isWithin(root, realRoot))) {
    throw new ReviewError('E001', `Project root outside allowed paths: ${projectRoot}`);
  }
}
