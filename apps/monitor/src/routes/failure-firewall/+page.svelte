<script lang="ts">
import MonitorTable from '$lib/components/MonitorTable.svelte';
import type { MonitorDataInventory } from '$lib/monitor/types';
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';

type FirewallItem = {
  kind: 'golden_path' | 'pattern';
  id: string;
  title: string;
  status: string;
  severity: string;
  updatedAt: string | null;
};

let items = $state<FirewallItem[]>([]);
let inventory = $state<MonitorDataInventory | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let actionLoadingId = $state<string | null>(null);
const columns = [
  { id: 'kind', label: 'kind', sortable: true, sortValue: (item: FirewallItem) => item.kind },
  { id: 'id', label: 'id', sortable: true, sortValue: (item: FirewallItem) => item.id },
  { id: 'title', label: 'title', sortable: true, sortValue: (item: FirewallItem) => item.title },
  { id: 'status', label: 'status', sortable: true, sortValue: (item: FirewallItem) => item.status },
  {
    id: 'severity',
    label: 'severity',
    sortable: true,
    sortValue: (item: FirewallItem) => item.severity,
  },
  {
    id: 'updated',
    label: 'updated',
    sortable: true,
    sortValue: (item: FirewallItem) => item.updatedAt ?? '',
  },
  { id: 'actions', label: 'actions' },
];

const load = async () => {
  loading = true;
  error = null;
  try {
    const [nextItems, nextInventory] = await Promise.all([
      invoke<FirewallItem[]>('monitor_failure_firewall'),
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

onMount(() => {
  void load();
});

const canApprove = (item: FirewallItem) => item.status === 'needs_review';
const canDeprecate = (item: FirewallItem) => item.status === 'active';
const firewallRows = $derived(
  (inventory?.categories.find((x) => x.table === 'failure_firewall_golden_paths')?.rowCount ?? 0) +
    (inventory?.categories.find((x) => x.table === 'failure_firewall_patterns')?.rowCount ?? 0),
);

const runAction = async (item: FirewallItem, action: 'approve' | 'deprecate' | 'increment-fp') => {
  actionLoadingId = `${item.kind}:${item.id}:${action}`;
  error = null;
  try {
    await invoke('monitor_failure_firewall_action', {
      action,
      kind: item.kind,
      id: item.id,
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
      <h1>Failure Firewall</h1>
      <div style="margin-top: 4px; font-size: 0.82rem; color: var(--text-muted);">golden paths / patterns</div>
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
    infoText={`source: failure_firewall_golden_paths + failure_firewall_patterns / tableRows: ${firewallRows} / loaded: ${items.length}`}
    emptyText={`No firewall data (table rows: ${firewallRows})`}
    keyOf={(item) => `${item.kind}:${item.id}`}
  >
    {#snippet row(item: FirewallItem)}
      <td>{item.kind}</td>
      <td>{item.id}</td>
      <td>{item.title}</td>
      <td>{item.status}</td>
      <td>{item.severity}</td>
      <td>{formatTime(item.updatedAt)}</td>
      <td>
        <div style="display:flex; gap:6px;">
          <button type="button" class="small-btn" disabled={!canApprove(item) || actionLoadingId !== null} onclick={() => void runAction(item, 'approve')}>Approve</button>
          <button type="button" class="small-btn" disabled={!canDeprecate(item) || actionLoadingId !== null} onclick={() => void runAction(item, 'deprecate')}>Deprecate</button>
          <button type="button" class="small-btn" disabled={item.kind !== 'pattern' || actionLoadingId !== null} onclick={() => void runAction(item, 'increment-fp')}>FP +1</button>
        </div>
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
