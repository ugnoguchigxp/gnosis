import { ReviewError } from '../errors.js';

export interface MaskResult {
  masked: string;
  maskCount: number;
  hadSecrets: boolean;
}

type SecretPattern = {
  pattern: RegExp;
  label: string;
};

const SECRET_PATTERNS: SecretPattern[] = [
  { pattern: /api[_-]?key\s*[:=]\s*['"]([^'"]{8,})['"]/gi, label: 'API_KEY' },
  { pattern: /bearer\s+([a-zA-Z0-9_\-.]{20,})/gi, label: 'BEARER_TOKEN' },
  { pattern: /AKIA[0-9A-Z]{16}/g, label: 'AWS_KEY' },
  {
    pattern: /-----BEGIN[A-Z ]+PRIVATE KEY-----[\s\S]+?-----END[A-Z ]+PRIVATE KEY-----/g,
    label: 'PRIVATE_KEY',
  },
  { pattern: /password\s*[:=]\s*['"]([^'"]{4,})['"]/gi, label: 'PASSWORD' },
  { pattern: /token\s*[:=]\s*['"]([^'"]{8,})['"]/gi, label: 'TOKEN' },
  { pattern: /secret\s*[:=]\s*['"]([^'"]{8,})['"]/gi, label: 'SECRET' },
];

const EXCLUSION_PATTERNS = [/your[_-]api[_-]?key/i, /xxx+/i, /\$\{[^}]+\}/, /process\.env\./];

export function maskSecrets(input: string): MaskResult {
  let masked = input;
  let maskCount = 0;

  for (const { pattern, label } of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      if (EXCLUSION_PATTERNS.some((pattern) => pattern.test(match))) {
        return match;
      }

      maskCount += 1;
      return `[MASKED:${label}]`;
    });
  }

  return { masked, maskCount, hadSecrets: maskCount > 0 };
}

export function maskOrThrow(input: string, allowCloud: boolean): string {
  try {
    return maskSecrets(input).masked;
  } catch (error) {
    if (!allowCloud) return input;
    throw new ReviewError('E004', `Secret masking failed; cannot send to cloud LLM: ${error}`);
  }
}
