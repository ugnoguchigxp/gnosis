<script lang="ts">
import { createDetailRequestGuard } from '$lib/monitor/detailRequestGuard';
import type { TaskDetailPayload, TaskHistoryEntry } from '$lib/monitor/types';
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';

type TaskStatusGroup = 'upcoming' | 'active' | 'history';

let tasks = $state<TaskHistoryEntry[]>([]);
let loading = $state(true);
let errorMessage = $state<string | null>(null);
// biome-ignore lint/style/useConst: $state value is reassigned via tab click handlers
let activeTab = $state<TaskStatusGroup>('active');

let detailOpen = $state(false);
let selectedTask = $state<TaskHistoryEntry | null>(null);
let selectedDetail = $state<TaskDetailPayload | null>(null);
let detailLoading = $state(false);
let detailError = $state<string | null>(null);
let actionLoadingTaskId = $state<string | null>(null);
let actionError = $state<string | null>(null);

const detailRequestGuard = createDetailRequestGuard();

const loadTasks = async () => {
  loading = true;
  errorMessage = null;
  try {
    const result = await invoke<TaskHistoryEntry[]>('monitor_list_tasks');
    tasks = result;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
  }
};

const groupedTasks = $derived.by(() => {
  const upcoming = tasks.filter((t) => ['pending', 'deferred'].includes(t.status));
  const active = tasks.filter((t) => t.status === 'running');
  const history = tasks.filter((t) => ['done', 'failed', 'unknown'].includes(t.status));
  return { upcoming, active, history };
});

const displayTasks = $derived(groupedTasks[activeTab]);

const formatTime = (ts: string | null | undefined): string => {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('ja-JP', { hour12: false });
};

const formatEpochMs = (ts: number | null | undefined): string => {
  if (!ts || !Number.isFinite(ts)) return '-';
  return new Date(ts).toLocaleString('ja-JP', { hour12: false });
};
const truncate = (value: string | null, max = 72): string => {
  if (!value) return '-';
  return value.length > max ? `${value.slice(0, max)}...` : value;
};

const isStaleRunning = (task: TaskHistoryEntry): boolean => {
  if (task.status !== 'running') return false;
  const updated = Date.parse(task.updatedAt);
  if (!Number.isFinite(updated)) return false;
  return Date.now() - updated > 30 * 60 * 1000;
};

const openDetail = async (task: TaskHistoryEntry) => {
  const requestSeq = detailRequestGuard.next();
  selectedTask = task;
  detailOpen = true;
  detailLoading = true;
  detailError = null;
  selectedDetail = null;

  try {
    const detail = await invoke<TaskDetailPayload>('monitor_task_detail', {
      taskId: task.id,
      task_id: task.id,
    });
    if (detailRequestGuard.isCurrent(requestSeq)) {
      selectedDetail = detail;
    }
  } catch (err) {
    if (detailRequestGuard.isCurrent(requestSeq)) {
      detailError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (detailRequestGuard.isCurrent(requestSeq)) {
      detailLoading = false;
    }
  }
};

const closeDetail = () => {
  detailRequestGuard.invalidate();
  detailOpen = false;
  selectedTask = null;
  selectedDetail = null;
};

const canRetry = (task: TaskHistoryEntry): boolean => ['failed', 'deferred'].includes(task.status);
const canDefer = (task: TaskHistoryEntry): boolean => ['pending', 'deferred'].includes(task.status);

const handleRetry = async (task: TaskHistoryEntry) => {
  actionLoadingTaskId = task.id;
  actionError = null;
  try {
    await invoke('monitor_retry_task', { taskId: task.id, task_id: task.id });
    await loadTasks();
  } catch (err) {
    actionError = err instanceof Error ? err.message : String(err);
  } finally {
    actionLoadingTaskId = null;
  }
};

const handleDefer = async (task: TaskHistoryEntry, deferMinutes = 15) => {
  actionLoadingTaskId = task.id;
  actionError = null;
  try {
    await invoke('monitor_defer_task', {
      taskId: task.id,
      task_id: task.id,
      deferMinutes,
      defer_minutes: deferMinutes,
    });
    await loadTasks();
  } catch (err) {
    actionError = err instanceof Error ? err.message : String(err);
  } finally {
    actionLoadingTaskId = null;
  }
};

onMount(() => {
  void loadTasks();
});
</script>

<main>
    <div class="top-row">
        <div>
            <h1>Task Queue</h1>
            <div style="margin-top: 4px; font-size: 0.82rem; color: var(--text-muted);">
                KnowFlow scheduling
            </div>
        </div>
        <button type="button" class="refresh-btn" onclick={loadTasks} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
        </button>
    </div>

    <div class="tabs">
        <button 
            class="tab-btn" 
            class:active={activeTab === 'upcoming'} 
            onclick={() => activeTab = 'upcoming'}
        >
            Upcoming <span class="tab-count">{groupedTasks.upcoming.length}</span>
        </button>
        <button 
            class="tab-btn" 
            class:active={activeTab === 'active'} 
            onclick={() => activeTab = 'active'}
        >
            Active <span class="tab-count">{groupedTasks.active.length}</span>
        </button>
        <button 
            class="tab-btn" 
            class:active={activeTab === 'history'} 
            onclick={() => activeTab = 'history'}
        >
            History <span class="tab-count">{groupedTasks.history.length}</span>
        </button>
    </div>

    {#if errorMessage}
        <div class="panel error-panel" style="margin-bottom: 1rem;">
            {errorMessage}
        </div>
    {/if}
    {#if actionError}
        <div class="panel error-panel" style="margin-bottom: 1rem;">
            {actionError}
        </div>
    {/if}

    <section class="panel">
        <table>
            <thead>
                <tr>
                    <th>topic</th>
                    <th>status</th>
                    <th>priority</th>
                    <th>source</th>
                    <th>result</th>
                    <th>error</th>
                    <th>lock owner</th>
                    <th>next run</th>
                    <th>created at</th>
                    <th>updated at</th>
                    <th>actions</th>
                </tr>
            </thead>
            <tbody>
                {#if loading && tasks.length === 0}
                    <tr><td colspan="11" style="text-align: center; color: var(--text-muted); padding: 2rem;">Loading tasks...</td></tr>
                {:else if displayTasks.length === 0}
                    <tr><td colspan="11" style="text-align: center; color: var(--text-muted); padding: 2rem;">No tasks in this category</td></tr>
                {:else}
                    {#each displayTasks as task (task.id)}
                        <tr class="clickable-row">
                            <td class="topic-cell">{task.topic || '(no topic)'}</td>
                            <td>
                                <span class={`status-badge ${task.status}`}>{task.status}</span>
                                {#if isStaleRunning(task)}
                                    <span class="stale-badge">stale</span>
                                {/if}
                            </td>
                            <td>{task.priority}</td>
                            <td>{task.source || '-'}</td>
                            <td title={task.resultSummary || ''}>{truncate(task.resultSummary)}</td>
                            <td title={task.errorReason || ''}>{truncate(task.errorReason)}</td>
                            <td>{task.lockOwner || '-'}</td>
                            <td>{formatEpochMs(task.nextRunAt)}</td>
                            <td>{formatTime(task.createdAt)}</td>
                            <td>{formatTime(task.updatedAt)}</td>
                            <td>
                                <div style="display:flex; gap:6px;">
                                    <button type="button" class="small-btn" onclick={() => void openDetail(task)}>Detail</button>
                                    <button type="button" class="small-btn" disabled={!canRetry(task) || actionLoadingTaskId === task.id} onclick={() => void handleRetry(task)}>Retry</button>
                                    <button type="button" class="small-btn" disabled={!canDefer(task) || actionLoadingTaskId === task.id} onclick={() => void handleDefer(task)}>Defer 15m</button>
                                </div>
                            </td>
                        </tr>
                    {/each}
                {/if}
            </tbody>
        </table>
    </section>
</main>

{#if detailOpen}
    <div class="detail-overlay">
        <button type="button" class="detail-backdrop" onclick={closeDetail} aria-label="close detail panel"></button>
        <aside class="detail-sheet">
            <div class="detail-header">
                <h2>Task Detail</h2>
                <button type="button" onclick={closeDetail} class="close-btn">Close</button>
            </div>
            
            {#if selectedTask}
                <div class="metadata-summary">
                    <div><strong>ID:</strong> {selectedTask.id}</div>
                    <div><strong>Status:</strong> {selectedTask.status}</div>
                    <div><strong>Topic:</strong> {selectedTask.topic || '-'}</div>
                </div>
            {/if}

            <hr style="border: 0; border-top: 1px solid var(--panel-border); margin: 1.5rem 0;" />

            {#if detailLoading}
                <div style="padding: 2rem; text-align: center;">Loading detailed logs...</div>
            {:else if detailError}
                <div class="error-text" style="padding: 1rem;">{detailError}</div>
            {:else if selectedDetail}
                <div class="detail-grid">
                    <div class="detail-item">
                        <div class="detail-label">Payload</div>
                        <pre>{JSON.stringify(selectedTask?.payload, null, 2)}</pre>
                    </div>
                </div>

                <div style="margin-top: 2rem;">
                    <h3>Related Logs</h3>
                    <div class="log-table-container">
                        <table>
                            <thead>
                                <tr><th>time</th><th>kind</th><th>detail</th></tr>
                            </thead>
                            <tbody>
                                {#if selectedDetail.logs.length === 0}
                                    <tr><td colspan="3" style="text-align:center; color: var(--text-muted); padding: 1rem;">No logs found for this task</td></tr>
                                {:else}
                                    {#each selectedDetail.logs as log}
                                        <tr>
                                            <td style="white-space: nowrap;">{new Date(log.ts).toLocaleTimeString('ja-JP')}</td>
                                            <td><span class="log-kind">{log.kind}</span></td>
                                            <td class="log-message">{log.error || log.summary || log.message || '-'}</td>
                                        </tr>
                                    {/each}
                                {/if}
                            </tbody>
                        </table>
                    </div>
                </div>
            {/if}
        </aside>
    </div>
{/if}

<style>
    .refresh-btn {
        padding: 8px 16px;
        background: var(--accent-primary);
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 0.9rem;
        font-weight: 500;
        transition: all 0.2s;
    }
    .refresh-btn:hover:not(:disabled) {
        filter: brightness(1.1);
        transform: translateY(-1px);
    }
    .refresh-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 1.5rem;
        padding: 4px;
        background: rgba(15, 23, 42, 0.4);
        border-radius: 12px;
        width: fit-content;
    }
    .tab-btn {
        padding: 8px 16px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 8px;
        cursor: pointer;
        font-size: 0.9rem;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: all 0.2s;
    }
    .tab-btn.active {
        background: var(--accent-primary);
        color: white;
    }
    .tab-count {
        font-size: 0.75rem;
        background: rgba(255, 255, 255, 0.1);
        padding: 2px 6px;
        border-radius: 4px;
    }

    .topic-cell {
        font-weight: 500;
        color: var(--text-primary);
    }

    .status-badge {
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
    }
    .status-badge.pending { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }
    .status-badge.running { background: rgba(59, 130, 246, 0.1); color: #60a5fa; }
    .status-badge.done { background: rgba(16, 185, 129, 0.1); color: #34d399; }
    .status-badge.failed { background: rgba(239, 68, 68, 0.1); color: #f87171; }
    .status-badge.deferred { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
    .stale-badge {
        margin-left: 6px;
        font-size: 0.68rem;
        color: #fca5a5;
        border: 1px solid rgba(248, 113, 113, 0.45);
        border-radius: 4px;
        padding: 1px 5px;
    }
    .small-btn {
        padding: 3px 8px;
        font-size: 0.75rem;
        border: 1px solid var(--panel-border);
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.6);
        color: var(--text-secondary);
        cursor: pointer;
    }
    .small-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }

    .detail-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1.5rem;
    }
    .close-btn {
        background: transparent;
        border: 1px solid var(--panel-border);
        color: var(--text-secondary);
        padding: 4px 12px;
        border-radius: 6px;
        cursor: pointer;
    }

    .metadata-summary {
        font-size: 0.875rem;
        display: flex;
        flex-direction: column;
        gap: 8px;
        color: var(--text-secondary);
    }

    .detail-item .detail-label {
        display: block;
        font-size: 0.75rem;
        text-transform: uppercase;
        color: var(--text-muted);
        margin-bottom: 0.5rem;
    }
    pre {
        background: rgba(0, 0, 0, 0.3);
        padding: 1rem;
        border-radius: 8px;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-size: 0.8rem;
        overflow-x: auto;
        color: #e2e8f0;
    }

    .log-kind {
        font-size: 0.7rem;
        font-weight: 600;
        color: var(--accent-primary);
        background: rgba(59, 130, 246, 0.1);
        padding: 2px 4px;
        border-radius: 3px;
    }
    .log-message {
        color: var(--text-secondary);
        font-size: 0.85rem;
    }
    .error-text {
        color: var(--accent-danger);
        background: rgba(239, 68, 68, 0.1);
        border-radius: 8px;
    }
</style>
