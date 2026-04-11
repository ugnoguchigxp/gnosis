export type RunMetricSample = {
  taskId: string;
  source: 'user' | 'cron';
  ok: boolean;
  changed?: boolean;
  retries: number;
  acceptedClaims: number;
  rejectedClaims: number;
  conflicts: number;
  latestSourceAgeDays?: number;
};

export type MetricsSnapshot = {
  totals: {
    runs: number;
    succeeded: number;
    failed: number;
    retries: number;
    mergeChanged: number;
  };
  kpi: {
    successRate: number;
    retryRate: number;
    mergeAcceptance: number;
    freshnessLagDays: number | null;
  };
};

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

export class MetricsCollector {
  private readonly samples: RunMetricSample[] = [];

  record(sample: RunMetricSample): void {
    this.samples.push(sample);
  }

  snapshot(): MetricsSnapshot {
    const runs = this.samples.length;
    const succeeded = this.samples.filter((sample) => sample.ok).length;
    const failed = runs - succeeded;
    const retries = this.samples.reduce((sum, sample) => sum + sample.retries, 0);
    const mergeChanged = this.samples.filter((sample) => sample.changed).length;

    const acceptedClaims = this.samples.reduce((sum, sample) => sum + sample.acceptedClaims, 0);
    const totalReviewedClaims = this.samples.reduce(
      (sum, sample) => sum + sample.acceptedClaims + sample.rejectedClaims,
      0,
    );
    const freshnessValues = this.samples
      .map((sample) => sample.latestSourceAgeDays)
      .filter((value): value is number => typeof value === 'number');

    return {
      totals: {
        runs,
        succeeded,
        failed,
        retries,
        mergeChanged,
      },
      kpi: {
        successRate: runs > 0 ? clamp(succeeded / runs) : 0,
        retryRate: runs > 0 ? retries / runs : 0,
        mergeAcceptance: totalReviewedClaims > 0 ? clamp(acceptedClaims / totalReviewedClaims) : 0,
        freshnessLagDays:
          freshnessValues.length > 0
            ? freshnessValues.reduce((sum, value) => sum + value, 0) / freshnessValues.length
            : null,
      },
    };
  }
}
