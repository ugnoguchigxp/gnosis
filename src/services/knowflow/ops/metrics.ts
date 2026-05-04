import type { TaskSource } from '../domain/task';

export type RunMetricSample = {
  taskId: string;
  source: TaskSource;
  ok: boolean;
  changed?: boolean;
  retries: number;
  recordedNotes: number;
  missedNotes: number;
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
    noteAcceptance: number;
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

    const recordedNotes = this.samples.reduce((sum, sample) => sum + sample.recordedNotes, 0);
    const totalNoteAttempts = this.samples.reduce(
      (sum, sample) => sum + sample.recordedNotes + sample.missedNotes,
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
        noteAcceptance: totalNoteAttempts > 0 ? clamp(recordedNotes / totalNoteAttempts) : 0,
        freshnessLagDays:
          freshnessValues.length > 0
            ? freshnessValues.reduce((sum, value) => sum + value, 0) / freshnessValues.length
            : null,
      },
    };
  }
}
