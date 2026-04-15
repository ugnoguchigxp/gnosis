import type { NormalizedDiff } from '../types.js';

const RISK_SIGNAL_PATTERNS: Record<string, RegExp[]> = {
  auth: [/auth[_-]?(?:middleware|guard|token|jwt)/i, /requiresAuth/i],
  permission: [/(?:can|has)[A-Z][a-z]+Permission/],
  payment: [/stripe|payment|billing|charge/i],
  deletion: [/delete|remove|drop|truncate/i],
  migration: [/migration|migrate|ALTER TABLE|CREATE TABLE/i],
  transaction: [/transaction|BEGIN|COMMIT|ROLLBACK/i],
  concurrency: [/mutex|lock|semaphore|atomic|race/i],
  cache_invalidation: [/invalidate|evict|flush.*cache/i],
  input_validation: [/validate|sanitize|escape/i],
  external_api_error: [/fetch|axios|got|http\.(?:get|post)/i],
  db_schema_change: [/schema\.ts|\.sql|migration/i],
  config_changed: [/\.env|config\.|settings\./i],
  tests_absent: [/TODO.*test|FIXME.*test/i],
  comment_only: [/^\s*\/\/|^\s*\/\*/m],
  type_annotation: [/:\s*[A-Z][A-Za-z0-9_<>,\[\]| ]+/],
  rename_only: [/\b(?:rename|renamed)\b/i],
  style_change: [/prettier|format/i],
  docs_only: [/\.md$/i],
};

export function extractRiskSignals(diffs: NormalizedDiff[]): string[] {
  const signals = new Set<string>();

  for (const diff of diffs) {
    const content = diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.content)).join('\n');

    for (const [signal, patterns] of Object.entries(RISK_SIGNAL_PATTERNS)) {
      if (patterns.some((pattern) => pattern.test(content))) signals.add(signal);
    }

    if (diff.classification.isMigration) signals.add('migration');
    if (diff.classification.isConfig) signals.add('config_changed');
    if (diff.classification.isInfra) signals.add('infra_change');
    if (diff.changeType === 'renamed') signals.add('rename_only');
  }

  return [...signals];
}
