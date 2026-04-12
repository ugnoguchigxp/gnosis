import { describe, expect, it } from 'bun:test';
import { MetricsCollector } from '../../src/services/knowflow/ops/metrics';

describe('metrics collector', () => {
  it('returns zero snapshot when no samples were recorded', () => {
    const metrics = new MetricsCollector();
    const snapshot = metrics.snapshot();

    expect(snapshot.totals.runs).toBe(0);
    expect(snapshot.totals.succeeded).toBe(0);
    expect(snapshot.totals.failed).toBe(0);
    expect(snapshot.totals.retries).toBe(0);
    expect(snapshot.totals.mergeChanged).toBe(0);

    expect(snapshot.kpi.successRate).toBe(0);
    expect(snapshot.kpi.retryRate).toBe(0);
    expect(snapshot.kpi.mergeAcceptance).toBe(0);
    expect(snapshot.kpi.freshnessLagDays).toBeNull();
  });

  it('aggregates totals and KPI values from recorded samples', () => {
    const metrics = new MetricsCollector();

    metrics.record({
      taskId: 'task-1',
      source: 'user',
      ok: true,
      changed: true,
      retries: 0,
      acceptedClaims: 2,
      rejectedClaims: 1,
      conflicts: 0,
      latestSourceAgeDays: 2,
    });
    metrics.record({
      taskId: 'task-2',
      source: 'cron',
      ok: false,
      changed: false,
      retries: 1,
      acceptedClaims: 0,
      rejectedClaims: 2,
      conflicts: 1,
    });
    metrics.record({
      taskId: 'task-3',
      source: 'cron',
      ok: true,
      retries: 2,
      acceptedClaims: 1,
      rejectedClaims: 0,
      conflicts: 0,
      latestSourceAgeDays: 6,
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.totals.runs).toBe(3);
    expect(snapshot.totals.succeeded).toBe(2);
    expect(snapshot.totals.failed).toBe(1);
    expect(snapshot.totals.retries).toBe(3);
    expect(snapshot.totals.mergeChanged).toBe(1);

    expect(snapshot.kpi.successRate).toBeCloseTo(2 / 3, 6);
    expect(snapshot.kpi.retryRate).toBe(1);
    expect(snapshot.kpi.mergeAcceptance).toBe(0.5);
    expect(snapshot.kpi.freshnessLagDays).toBe(4);
  });
});
