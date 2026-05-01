<script lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';
import type { MonitorDataInventory } from '$lib/monitor/types';
import MonitorTable from '$lib/components/MonitorTable.svelte';

type ReviewItem = {
  id: string;
  taskId: string;
  repoPath: string;
  status: string;
  reviewStatus: string | null;
  createdAt: string | null;
  outcomeCount: number;
  pendingOutcomes: number;
};

let items = $state<ReviewItem[]>([]);
let inventory = $state<MonitorDataInventory | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let actionLoadingId = $state<string | null>(null);
const columns = [
  { id: 'id', label: 'id', sortable: true, sortValue: (item: ReviewItem) => item.id },
  { id: 'taskId', label: 'taskId', sortable: true, sortValue: (item: ReviewItem) => item.taskId },
  { id: 'status', label: 'status', sortable: true, sortValue: (item: ReviewItem) => item.status },
  {
    id: 'reviewStatus',
    label: 'reviewStatus',
    sortable: true,
    sortValue: (item: ReviewItem) => item.reviewStatus ?? '',
  },
  {
    id: 'outcomes',
    label: 'outcomes',
    sortable: true,
    sortValue: (item: ReviewItem) => item.outcomeCount,
  },
  {
    id: 'pending',
    label: 'pending',
    sortable: true,
    sortValue: (item: ReviewItem) => item.pendingOutcomes,
  },
  {
    id: 'created',
    label: 'created',
    sortable: true,
    sortValue: (item: ReviewItem) => item.createdAt ?? '',
  },
  {
    id: 'repoPath',
    label: 'repoPath',
    sortable: true,
    sortValue: (item: ReviewItem) => item.repoPath,
  },
  { id: 'actions', label: 'actions' },
];

const load = async () => {
  loading = true;
  error = null;
  try {
    const [nextItems, nextInventory] = await Promise.all([
      invoke<ReviewItem[]>('monitor_review_data'),
      invoke<MonitorDataInventory>('monitor_data_inventory'),
    ]);
    items = nextItems;
    inventory = nextInventory;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
  }
};

const formatTime = (value: string | null) => {
  if (!value) return '-';
  return new Date(value).toLocaleString('ja-JP', { hour12: false });
};
const reviewRows = $derived(
  (inventory?.categories.find((x) => x.table === 'review_cases')?.rowCount ?? 0) +
    (inventory?.categories.find((x) => x.table === 'review_outcomes')?.rowCount ?? 0),
);

onMount(() => {
  void load();
});

const createTaskNote = async (id: string) => {
  actionLoadingId = id;
  error = null;
  try {
    await invoke('monitor_review_action', {
      action: 'create-task-note',
      reviewCaseId: id,
      review_case_id: id,
    });
    await load();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    actionLoadingId = null;
  }
};
</script>

<main>
  <div class="top-row">
    <div>
      <h1>Review Cases</h1>
      <div style="margin-top: 4px; font-size: 0.82rem; color: var(--text-muted);">review_cases / review_outcomes</div>
    </div>
    <button type="button" class="refresh-btn" onclick={load} disabled={loading}>
      {loading ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>

  {#if error}
    <div class="panel error-panel" style="margin-bottom: 1rem;">{error}</div>
  {/if}

  <MonitorTable
    {columns}
    items={items}
    {loading}
    infoText={`source: review_cases + review_outcomes / tableRows: ${reviewRows} / loaded: ${items.length}`}
    emptyText={`No review data (table rows: ${reviewRows})`}
    keyOf={(item) => item.id}
  >
    {#snippet row(item: ReviewItem)}
      <td>{item.id}</td>
      <td>{item.taskId}</td>
      <td>{item.status}</td>
      <td>{item.reviewStatus ?? '-'}</td>
      <td>{item.outcomeCount}</td>
      <td>{item.pendingOutcomes}</td>
      <td>{formatTime(item.createdAt)}</td>
      <td>{item.repoPath}</td>
      <td>
        <button type="button" class="small-btn" disabled={actionLoadingId !== null} onclick={() => void createTaskNote(item.id)}>
          Task Note
        </button>
      </td>
    {/snippet}
  </MonitorTable>
</main>

<style>
  .small-btn {
    padding: 4px 8px;
    border: 1px solid var(--panel-border);
    background: rgba(15, 23, 42, 0.7);
    color: var(--text-secondary);
    border-radius: 6px;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .small-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
