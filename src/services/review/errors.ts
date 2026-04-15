export class ReviewError extends Error {
  constructor(
    public readonly code: keyof typeof ReviewErrors,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ReviewError';
  }
}

export const ReviewErrors = {
  E001: 'ROOT_VALIDATION_FAILED',
  E002: 'SESSION_ID_INVALID',
  E003: 'DIFF_TOO_LARGE',
  E004: 'SECRET_MASKING_FAILED',
  E005: 'GIT_COMMAND_FAILED',
  E006: 'LLM_TIMEOUT',
  E007: 'LLM_UNAVAILABLE',
  E008: 'DB_ERROR',
  E009: 'STATIC_ANALYSIS_FAILED',
  E010: 'DIFFGUARD_MCP_ERROR',
  E011: 'ASTMEND_MCP_ERROR',
} as const;

export const ReviewWarnings = {
  W001: 'DEGRADED_MODE',
  W002: 'NO_CHANGES_DETECTED',
  W003: 'BINARY_FILES_SKIPPED',
  W004: 'DIFFGUARD_UNAVAILABLE',
  W005: 'ASTMEND_UNAVAILABLE',
} as const;

export const REVIEW_LIMITS = {
  MAX_DIFF_LINES: 500,
  MAX_FILES: 20,
  MAX_LINES_PER_FILE: 300,
  MAX_SESSION_ID_LENGTH: 256,
  LLM_TIMEOUT_MS: 30_000,
  EXECUTION_RECORD_TTL_DAYS: 30,
} as const;
