<script lang="ts">
import MonitorTable from '$lib/components/MonitorTable.svelte';
import type { MonitorDataInventory } from '$lib/monitor/types';
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';

type SyncItem = {
  id: string;
  lastSyncedAt: string;
  cursor: Record<string, unknown>;
  updatedAt: string;
};

let items = $state<SyncItem[]>([]);
let inventory = $state<MonitorDataInventory | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let actionLoadingId = $state<string | null>(null);
const columns = [
  { id: 'id', label: 'id', sortable: true, sortValue: (item: SyncItem) => item.id },
  {
    id: 'lastSyncedAt',
    label: 'lastSyncedAt',
    sortable: true,
    sortValue: (item: SyncItem) => item.lastSyncedAt,
  },
  {
    id: 'updatedAt',
    label: 'updatedAt',
    sortable: true,
    sortValue: (item: SyncItem) => item.updatedAt,
  },
  { id: 'cursor', label: 'cursor' },
  { id: 'actions', label: 'actions' },
];

const load = async () => {
  loading = true;
  error = null;
  try {
    const [nextItems, nextInventory] = await Promise.all([
      invoke<SyncItem[]>('monitor_sync_state'),
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

onMount(() => {
  void load();
});
const syncRows = $derived(
  inventory?.categories.find((x) => x.table === 'sync_state')?.rowCount ?? 0,
);

const previewReset = async (id: string) => {
  actionLoadingId = `preview:${id}`;
  error = null;
  try {
    const preview = await invoke<{ confirmToken: string }>('monitor_sync_state_action', {
      action: 'preview-reset',
      id,
    });
    const confirmed = globalThis.confirm(
      `Reset cursor for ${id}?\nconfirm token: ${preview.confirmToken}`,
    );
    if (!confirmed) return;
    await invoke('monitor_sync_state_action', {
      action: 'reset',
      id,
      confirm: preview.confirmToken,
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
      <h1>Sync State</h1>
      <div style="margin-top: 4px; font-size: 0.82rem; color: var(--text-muted);">sync cursors</div>
    </div>
    <button type="button" class="refresh-btn" onclick={load} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
  </div>

  {#if error}<div class="panel error-panel" style="margin-bottom: 1rem;">{error}</div>{/if}

  <MonitorTable
    {columns}
    items={items}
    {loading}
    infoText={`source: sync_state / tableRows: ${syncRows} / loaded: ${items.length}`}
    emptyText={`No sync state (table rows: ${syncRows})`}
    keyOf={(item) => item.id}
  >
    {#snippet row(item: SyncItem)}
      <td>{item.id}</td>
      <td>{new Date(item.lastSyncedAt).toLocaleString('ja-JP', { hour12: false })}</td>
      <td>{new Date(item.updatedAt).toLocaleString('ja-JP', { hour12: false })}</td>
      <td><pre>{JSON.stringify(item.cursor, null, 2)}</pre></td>
      <td>
        <button
          type="button"
          class="small-btn"
          disabled={actionLoadingId !== null}
          onclick={() => void previewReset(item.id)}
        >
          Preview / Reset
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
