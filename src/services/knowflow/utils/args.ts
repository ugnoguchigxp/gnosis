export const parseArgMap = (argv: string[]): Record<string, string | boolean> => {
  const map: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const maybeValue = argv[i + 1];
    if (!maybeValue || maybeValue.startsWith('--')) {
      map[key] = true;
      continue;
    }

    map[key] = maybeValue;
    i += 1;
  }

  return map;
};

export const readStringFlag = (
  args: Record<string, string | boolean>,
  key: string,
): string | undefined => {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
};

export const readNumberFlag = (
  args: Record<string, string | boolean>,
  key: string,
): number | undefined => {
  const value = readStringFlag(args, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const readBooleanFlag = (args: Record<string, string | boolean>, key: string): boolean =>
  args[key] === true;
