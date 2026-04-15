import type { AstmendImpactSummary } from '../types.js';

const HIGH_RISK_SIGNALS = new Set([
  'auth',
  'permission',
  'payment',
  'deletion',
  'migration',
  'transaction',
  'concurrency',
  'cache_invalidation',
  'input_validation',
  'external_api_error',
  'high_impact_symbol',
  'cascading_change',
  'api_break_risk',
]);

const LOW_RISK_SIGNALS = new Set([
  'comment_only',
  'type_annotation',
  'rename_only',
  'style_change',
  'docs_only',
]);

export interface ReviewPlan {
  riskLevel: 'low' | 'medium' | 'high';
  useHeavyLLM: boolean;
  expandContext: boolean;
  reason: string;
}

export function planReview(signals: string[]): ReviewPlan {
  const highRiskFound = signals.filter((signal) => HIGH_RISK_SIGNALS.has(signal));
  const isLowRisk = signals.length > 0 && signals.every((signal) => LOW_RISK_SIGNALS.has(signal));

  if (highRiskFound.length > 0) {
    return {
      riskLevel: 'high',
      useHeavyLLM: true,
      expandContext: true,
      reason: `High-risk signals: ${highRiskFound.join(', ')}`,
    };
  }

  if (isLowRisk) {
    return {
      riskLevel: 'low',
      useHeavyLLM: false,
      expandContext: false,
      reason: 'Low-risk changes only',
    };
  }

  return {
    riskLevel: 'medium',
    useHeavyLLM: true,
    expandContext: false,
    reason: 'Standard review',
  };
}

export function enrichRiskSignalsWithImpact(
  signals: string[],
  impact: AstmendImpactSummary,
): string[] {
  const enriched = [...signals];

  for (const symbol of impact.symbols) {
    if (symbol.references.length >= 5) {
      enriched.push('high_impact_symbol');
    }

    if (symbol.impactedDeclarations.length > 0) {
      enriched.push('cascading_change');
    }

    const externalRefs = symbol.references.filter((reference) => reference.file !== symbol.file);
    if (externalRefs.length > 0) {
      enriched.push('api_break_risk');
    }
  }

  return [...new Set(enriched)];
}
