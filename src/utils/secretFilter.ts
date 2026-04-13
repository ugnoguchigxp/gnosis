export const SECRET_PATTERNS: RegExp[] = [
  /export\s+[A-Z_]*PASSWORD=.*$/gim,
  /export\s+[A-Z_]*TOKEN=.*$/gim,
  /export\s+[A-Z_]*KEY=.*$/gim,
  /password\s*[:=]\s*\S+/gi,
  /secret[_-]?key\s*[:=]\s*\S+/gi,
  /auth[_-]?token\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /bearer\s+[a-z0-9\-_.]+/gi,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
  /xox[baprs]-\S+/gm,
  /ghp_\S+/gm,
  /ghs_\S+/gm,
  /([a-zA-Z0-9]{32,})/g,
];

const SECRET_LINE_KEYWORDS = ['password', 'secret_key', 'auth_token'];

/**
 * 機密情報（APIキー、トークン、パスワード等）を検知し、
 * そのブロックを完全に排除します。
 */
export function filterSensitiveData(text: string): string {
  let filtered = text;
  for (const pattern of SECRET_PATTERNS) {
    filtered = filtered.replace(pattern, '[REMOVED SENSITIVE DATA]');
  }

  const lines = filtered.split('\n');
  const cleanLines = lines.filter((line) => {
    const lower = line.toLowerCase();
    return !SECRET_LINE_KEYWORDS.some((kw) => lower.includes(kw));
  });

  return cleanLines.join('\n');
}

export const containsSecret = (line: string): boolean =>
  SECRET_PATTERNS.some((pattern) => {
    const cloned = new RegExp(pattern.source, pattern.flags);
    return cloned.test(line);
  });
