<script lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';
import type { MonitorDataInventory } from '$lib/monitor/types';
import MonitorTable from '$lib/components/MonitorTable.svelte';

type EvalSummaryRow = { [key: string]: string | number };
type EvalPayload = {
  summary: {
    byDecision: EvalSummaryRow[];
    byModelAlias: EvalSummaryRow[];
    byThreshold: EvalSummaryRow[];
  };
  recent: Array<{
    id: string;
    runId: string;
    topic: string;
    decision: string;
    threshold: number;
    modelAlias: string;
    createdAt: string;
  }>;
};

let payload = $state<EvalPayload | null>(null);
let inventory = $state<MonitorDataInventory | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
const recentColumns = [
  {
    id: 'time',
    label: 'time',
    sortable: true,
    sortValue: (item: EvalPayload['recent'][number]) => item.createdAt,
  },
  {
    id: 'topic',
    label: 'topic',
    sortable: true,
    sortValue: (item: EvalPayload['recent'][number]) => item.topic,
  },
  {
    id: 'decision',
    label: 'decision',
    sortable: true,
    sortValue: (item: EvalPayload['recent'][number]) => item.decision,
  },
  {
    id: 'threshold',
    label: 'threshold',
    sortable: true,
    sortValue: (item: EvalPayload['recent'][number]) => item.threshold,
  },
  {
    id: 'model',
    label: 'model',
    sortable: true,
    sortValue: (item: EvalPayload['recent'][number]) => item.modelAlias,
  },
];

const load = async () => {
  loading = true;
  error = null;
  try {
    const [nextPayload, nextInventory] = await Promise.all([
      invoke<EvalPayload>('monitor_knowflow_evals'),
      invoke<MonitorDataInventory>('monitor_data_inventory'),
    ]);
    payload = nextPayload;
    inventory = nextInventory;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
  }
};

onMount(() => {
  void load();
});
const evalRows = $derived(
  inventory?.categories.find((x) => x.table === 'knowflow_keyword_evaluations')?.rowCount ?? 0,
);
</script>

<main>
  <div class="top-row">
    <div>
      <h1>KnowFlow Evaluations</h1>
      <div style="margin-top: 4px; font-size: 0.82rem; color: var(--text-muted);">decision / threshold / modelAlias</div>
    </div>
    <button type="button" class="refresh-btn" onclick={load} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
  </div>

  {#if error}<div class="panel error-panel" style="margin-bottom: 1rem;">{error}</div>{/if}

  {#if payload}
    <section class="panel" style="margin-bottom: 12px;">
      <div style="color: var(--text-muted); font-size: 0.82rem;">
        source: knowflow_keyword_evaluations / tableRows: {evalRows} / loaded(recent): {payload.recent.length}
      </div>
    </section>
    <div class="grid">
      <section class="panel">
        <h2>By Decision</h2>
        <pre>{JSON.stringify(payload.summary.byDecision, null, 2)}</pre>
      </section>
      <section class="panel">
        <h2>By Model</h2>
        <pre>{JSON.stringify(payload.summary.byModelAlias, null, 2)}</pre>
      </section>
      <section class="panel">
        <h2>By Threshold</h2>
        <pre>{JSON.stringify(payload.summary.byThreshold, null, 2)}</pre>
      </section>
    </div>

    <div style="margin-top: 12px;">
      <h2>Recent</h2>
      <MonitorTable
        columns={recentColumns}
        items={payload.recent}
        {loading}
        emptyText={`No eval data (table rows: ${evalRows})`}
        keyOf={(item) => item.id}
      >
        {#snippet row(item: EvalPayload['recent'][number])}
          <td>{new Date(item.createdAt).toLocaleString('ja-JP', { hour12: false })}</td>
          <td>{item.topic}</td>
          <td>{item.decision}</td>
          <td>{item.threshold}</td>
          <td>{item.modelAlias}</td>
        {/snippet}
      </MonitorTable>
    </div>
  {/if}
</main>
