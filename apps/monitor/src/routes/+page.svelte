<script lang="ts">
import { MonitorWsClient } from '$lib/monitor/client';
import { createDetailRequestGuard } from '$lib/monitor/detailRequestGuard';
import type {
  ConnectionStatus,
  MonitorConfigResponse,
  MonitorSnapshotData,
  TaskDetailPayload,
  TaskIndexEntry,
  TimelineEvent,
} from '$lib/monitor/types';
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';

type TimelineStatus = 'done' | 'failed' | 'deferred' | 'degraded' | 'unknown';
type EnrichedTimelineEvent = TimelineEvent & {
  status: TimelineStatus;
  source: string | null;
  topic: string | null;
};

const TIMELINE_PAGE_SIZE = 20;
const TIMELINE_MAX_PAGES = 10;
const TIMELINE_BUFFER_LIMIT = TIMELINE_PAGE_SIZE * TIMELINE_MAX_PAGES;
const DETAIL_CACHE_LIMIT = 50;

const createInitialSnapshot = (): MonitorSnapshotData => ({
  queue: {
    pending: 0,
    running: 0,
    deferred: 0,
    failed: 0,
  },
  worker: {
    lastSuccessTs: null,
    lastFailureTs: null,
    consecutiveFailures: 0,
  },
  eval: {
    degradedRate: 0,
    passed: 0,
    failed: 0,
    updatedAtTs: null,
  },
  taskIndex: [],
});

let snapshot = $state<MonitorSnapshotData>(createInitialSnapshot());
let timeline = $state<TimelineEvent[]>([]);
let connectionStatus = $state<ConnectionStatus>('offline');
// biome-ignore lint/style/useConst: Svelte 5 $state needs let for bind:value in template
let autoUpdate = $state(true);
let currentTimelinePage = $state(1);
// biome-ignore lint/style/useConst: Svelte 5 $state needs let for bind:value in template
let statusFilter = $state<'all' | TimelineStatus>('all');
// biome-ignore lint/style/useConst: Svelte 5 $state needs let for bind:value in template
let sourceFilter = $state<'all' | string>('all');
// biome-ignore lint/style/useConst: Svelte 5 $state needs let for bind:value in template
let topicFilter = $state('');
let lastSnapshotTs = $state<number | null>(null);
let errorMessage = $state<string | null>(null);
let wsUrl = $state<string>('');

let detailOpen = $state(false);
let selectedEvent = $state<EnrichedTimelineEvent | null>(null);
let selectedDetail = $state<TaskDetailPayload | null>(null);
let detailLoading = $state(false);
let detailError = $state<string | null>(null);

let enqueueOpen = $state(false);
let enqueueTopic = $state('');
let enqueueMode = $state<'directed' | 'expand' | 'explore'>('directed');
let enqueuePriority = $state(50);
let enqueueLoading = $state(false);
let enqueueError = $state<string | null>(null);
let enqueueSuccess = $state<string | null>(null);

const detailCache = new Map<string, TaskDetailPayload>();
const detailCacheOrder: string[] = [];
const detailRequestGuard = createDetailRequestGuard();

const statusClass = $derived(connectionStatus);
const taskIndexMap = $derived.by(() => {
  const map = new Map<string, TaskIndexEntry>();
  for (const item of snapshot.taskIndex) {
    map.set(item.taskId, item);
  }
  return map;
});
const sourceOptions = $derived.by(() => {
  const sourceSet = new Set<string>();
  for (const item of snapshot.taskIndex) {
    if (item.source) {
      sourceSet.add(item.source);
    }
  }
  return [...sourceSet].sort();
});

const normalizeStatus = (kind: string): TimelineStatus => {
  if (kind === 'task.done') return 'done';
  if (kind === 'task.failed') return 'failed';
  if (kind === 'task.deferred') return 'deferred';
  if (kind === 'llm.task.degraded') return 'degraded';
  return 'unknown';
};

const filteredTimeline = $derived.by(() => {
  const loweredTopic = topicFilter.trim().toLowerCase();
  const result: EnrichedTimelineEvent[] = [];

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index];
    const taskIndex = event.taskId ? taskIndexMap.get(event.taskId) : undefined;
    const enrichedEvent: EnrichedTimelineEvent = {
      ...event,
      status: normalizeStatus(event.kind),
      source: taskIndex?.source ?? null,
      topic: taskIndex?.topic ?? null,
    };

    if (statusFilter !== 'all' && enrichedEvent.status !== statusFilter) {
      continue;
    }
    if (sourceFilter !== 'all' && enrichedEvent.source !== sourceFilter) {
      continue;
    }
    if (loweredTopic.length > 0) {
      const topic = enrichedEvent.topic?.toLowerCase() ?? '';
      if (!topic.includes(loweredTopic)) {
        continue;
      }
    }

    result.push(enrichedEvent);
  }

  return result;
});
const totalTimelinePages = $derived.by(() =>
  Math.max(1, Math.ceil(filteredTimeline.length / TIMELINE_PAGE_SIZE)),
);
const activeTimelinePage = $derived.by(() =>
  Math.min(Math.max(currentTimelinePage, 1), totalTimelinePages),
);
const timelineDisplay = $derived.by(() => {
  const startIndex = (activeTimelinePage - 1) * TIMELINE_PAGE_SIZE;
  return filteredTimeline.slice(startIndex, startIndex + TIMELINE_PAGE_SIZE);
});

let client: MonitorWsClient | null = null;

const formatTime = (ts: number | null | undefined): string => {
  if (!ts) {
    return '-';
  }
  return new Date(ts).toLocaleString('ja-JP', { hour12: false });
};

const eventDetail = (event: TimelineEvent): string => {
  return event.errorReason ?? event.resultSummary ?? event.message ?? '-';
};

const applyTimelineEvent = (event: TimelineEvent): void => {
  timeline = [...timeline, event].slice(-TIMELINE_BUFFER_LIMIT);
};

const cacheDetail = (taskId: string, detail: TaskDetailPayload): void => {
  detailCache.set(taskId, detail);
  const existingIndex = detailCacheOrder.indexOf(taskId);
  if (existingIndex >= 0) {
    detailCacheOrder.splice(existingIndex, 1);
  }
  detailCacheOrder.push(taskId);

  while (detailCacheOrder.length > DETAIL_CACHE_LIMIT) {
    const oldest = detailCacheOrder.shift();
    if (oldest) {
      detailCache.delete(oldest);
    }
  }
};

const loadTaskDetail = async (taskId: string, requestSeq: number): Promise<void> => {
  detailLoading = true;
  detailError = null;

  try {
    const cached = detailCache.get(taskId);
    if (cached) {
      if (detailRequestGuard.isCurrent(requestSeq)) {
        selectedDetail = cached;
      }
      return;
    }

    const detail = await invoke<TaskDetailPayload>('monitor_task_detail', {
      taskId,
      task_id: taskId,
    });
    if (detailRequestGuard.isCurrent(requestSeq)) {
      cacheDetail(taskId, detail);
      selectedDetail = detail;
    }
  } catch (error) {
    if (detailRequestGuard.isCurrent(requestSeq)) {
      detailError = error instanceof Error ? error.message : String(error);
      selectedDetail = null;
    }
  } finally {
    if (detailRequestGuard.isCurrent(requestSeq)) {
      detailLoading = false;
    }
  }
};

const openDetail = async (event: EnrichedTimelineEvent): Promise<void> => {
  const requestSeq = detailRequestGuard.next();
  selectedEvent = event;
  detailOpen = true;
  detailError = null;
  selectedDetail = null;

  if (!event.taskId) {
    return;
  }

  await loadTaskDetail(event.taskId, requestSeq);
};

const closeDetail = (): void => {
  detailRequestGuard.invalidate();
  detailOpen = false;
  selectedEvent = null;
  selectedDetail = null;
  detailError = null;
  detailLoading = false;
};

const openEnqueueDialog = (): void => {
  enqueueOpen = true;
  enqueueTopic = '';
  enqueueMode = 'directed';
  enqueuePriority = 50;
  enqueueError = null;
  enqueueSuccess = null;
};

const closeEnqueueDialog = (): void => {
  enqueueOpen = false;
  enqueueTopic = '';
  enqueueError = null;
  enqueueSuccess = null;
};

const submitEnqueueTask = async (): Promise<void> => {
  if (!enqueueTopic.trim()) {
    enqueueError = 'Topic is required';
    return;
  }
  enqueueLoading = true;
  enqueueError = null;
  enqueueSuccess = null;
  try {
    const result = await invoke<{ success: boolean; taskId: string }>('monitor_enqueue_task', {
      topic: enqueueTopic.trim(),
      mode: enqueueMode,
      priority: enqueuePriority,
    });
    if (result.success) {
      enqueueSuccess = `Task enqueued: ${result.taskId}`;
      setTimeout(closeEnqueueDialog, 2000);
    } else {
      enqueueError = 'Failed to enqueue task';
    }
  } catch (error) {
    enqueueError = error instanceof Error ? error.message : String(error);
  } finally {
    enqueueLoading = false;
  }
};

const initialize = async (): Promise<void> => {
  try {
    const config = await invoke<MonitorConfigResponse>('monitor_config');
    wsUrl = config.wsUrl;
    errorMessage = null;

    client = new MonitorWsClient({
      callbacks: {
        onSnapshot: (nextSnapshot, ts) => {
          if (!autoUpdate) return;
          snapshot = nextSnapshot;
          lastSnapshotTs = ts;
        },
        onEvent: (event) => {
          if (!autoUpdate) return;
          applyTimelineEvent(event);
        },
        onStatus: (status) => {
          connectionStatus = status;
        },
        onError: (message) => {
          errorMessage = message;
        },
        shouldApplyUpdates: () => autoUpdate,
      },
    });

    client.start(config.wsUrl);
  } catch (error) {
    connectionStatus = 'offline';
    errorMessage = error instanceof Error ? error.message : String(error);
  }
};

const onAutoUpdateChange = (): void => {
  if (autoUpdate) {
    client?.reconnectNow();
  }
};
const goToNextTimelinePage = (): void => {
  if (activeTimelinePage < totalTimelinePages) {
    currentTimelinePage = activeTimelinePage + 1;
  }
};
const goToPreviousTimelinePage = (): void => {
  if (activeTimelinePage > 1) {
    currentTimelinePage = activeTimelinePage - 1;
  }
};

$effect(() => {
  statusFilter;
  sourceFilter;
  topicFilter;
  currentTimelinePage = 1;
});

$effect(() => {
  if (currentTimelinePage > totalTimelinePages) {
    currentTimelinePage = totalTimelinePages;
  }
  if (currentTimelinePage < 1) {
    currentTimelinePage = 1;
  }
});

onMount(() => {
  void initialize();
  return () => {
    client?.stop();
  };
});
</script>

<main>
	<div class="top-row">
		<div>
			<h1>Gnosis Monitoring</h1>
			<div style="margin-top: 4px; font-size: 0.82rem; color: var(--text-muted);">WS: {wsUrl || '-'}</div>
		</div>
		<div style="display: flex; gap: 8px; align-items: center;">
			<button type="button" class="enqueue-btn" onclick={openEnqueueDialog}>+ Enqueue Task</button>
			<div class={`badge ${statusClass}`}>{connectionStatus}</div>
		</div>
	</div>

	<div class="panel" style="margin-bottom: 12px;">
			<div class="controls">
				<label class="control">
					<input type="checkbox" bind:checked={autoUpdate} onchange={onAutoUpdateChange} />
					<span>自動更新</span>
				</label>
				<div class="control">表示件数: {TIMELINE_PAGE_SIZE}件 / page</div>
			<label class="control">
				<span>status</span>
				<select bind:value={statusFilter}>
					<option value="all">all</option>
					<option value="done">done</option>
					<option value="failed">failed</option>
					<option value="deferred">deferred</option>
					<option value="degraded">degraded</option>
				</select>
			</label>
			<label class="control">
				<span>source</span>
				<select bind:value={sourceFilter}>
					<option value="all">all</option>
					{#each sourceOptions as source}
						<option value={source}>{source}</option>
					{/each}
				</select>
			</label>
			<label class="control">
				<span>topic</span>
				<input type="text" bind:value={topicFilter} placeholder="topic contains..." style="padding: 4px 8px;" />
			</label>
			<div class="control">最終 Snapshot: {formatTime(lastSnapshotTs)}</div>
		</div>
		{#if errorMessage}
			<div class="error-text">{errorMessage}</div>
		{/if}
	</div>

	<div class="grid">
		<section class="panel">
			<h2>Queue</h2>
			<div class="stat-row">
				<div class="metric"><div class="metric-label">pending</div><div class="metric-value">{snapshot.queue.pending}</div></div>
				<div class="metric"><div class="metric-label">running</div><div class="metric-value">{snapshot.queue.running}</div></div>
				<div class="metric"><div class="metric-label">deferred</div><div class="metric-value">{snapshot.queue.deferred}</div></div>
				<div class="metric"><div class="metric-label">failed</div><div class="metric-value">{snapshot.queue.failed}</div></div>
			</div>
		</section>

		<section class="panel">
			<h2>Worker</h2>
			<div class="stat-row">
				<div class="metric"><div class="metric-label">last success</div><div class="metric-value" style="font-size: 0.92rem;">{formatTime(snapshot.worker.lastSuccessTs)}</div></div>
				<div class="metric"><div class="metric-label">last failure</div><div class="metric-value" style="font-size: 0.92rem;">{formatTime(snapshot.worker.lastFailureTs)}</div></div>
				<div class="metric" style="grid-column: span 2;"><div class="metric-label">consecutive failures</div><div class="metric-value">{snapshot.worker.consecutiveFailures}</div></div>
			</div>
		</section>

		<section class="panel">
			<h2>Eval</h2>
			<div class="stat-row">
				<div class="metric"><div class="metric-label">degraded rate</div><div class="metric-value">{snapshot.eval.degradedRate.toFixed(2)}%</div></div>
				<div class="metric"><div class="metric-label">passed / failed</div><div class="metric-value">{snapshot.eval.passed} / {snapshot.eval.failed}</div></div>
				<div class="metric" style="grid-column: span 2;"><div class="metric-label">updated</div><div class="metric-value" style="font-size: 0.92rem;">{formatTime(snapshot.eval.updatedAtTs)}</div></div>
			</div>
		</section>
	</div>

	<section class="panel timeline">
		<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px;">
			<h2 style="margin: 0;">Timeline</h2>
			<div style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: var(--text-secondary);">
				<span>{filteredTimeline.length}件</span>
				<span>page {activeTimelinePage} / {totalTimelinePages}</span>
				<button type="button" onclick={goToPreviousTimelinePage} disabled={activeTimelinePage <= 1}>
					Prev
				</button>
				<button
					type="button"
					onclick={goToNextTimelinePage}
					disabled={activeTimelinePage >= totalTimelinePages}
				>
					Next
				</button>
			</div>
		</div>
		<table>
			<thead>
				<tr>
					<th>time</th>
					<th>kind</th>
					<th>status</th>
					<th>source</th>
					<th>topic</th>
					<th>taskId</th>
					<th>detail</th>
				</tr>
			</thead>
			<tbody>
				{#if timelineDisplay.length === 0}
					<tr><td colspan="7" style="text-align: center; color: #64748b;">No events yet</td></tr>
				{:else}
					{#each timelineDisplay as event (event.id)}
						<tr class="clickable-row" onclick={() => void openDetail(event)}>
							<td>{formatTime(event.ts)}</td>
							<td class="row-kind">{event.kind}</td>
							<td>{event.status}</td>
							<td>{event.source ?? '-'}</td>
							<td>{event.topic ?? '-'}</td>
							<td>{event.taskId ?? '-'}</td>
							<td class="row-detail">{eventDetail(event)}</td>
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
				<button type="button" onclick={closeDetail}>Close</button>
			</div>
			{#if selectedEvent}
				<div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 10px;">
					kind: {selectedEvent.kind}<br />
					taskId: {selectedEvent.taskId ?? '-'}
				</div>
			{/if}
			{#if detailLoading}
				<div>Loading detail...</div>
			{:else if detailError}
				<div class="error-text">{detailError}</div>
			{:else if selectedDetail}
				<div class="detail-metadata">
					<div><strong>runId:</strong> {selectedDetail.runId ?? '-'}</div>
					<div><strong>topic:</strong> {selectedDetail.topic ?? '-'}</div>
					<div><strong>source:</strong> {selectedDetail.source ?? '-'}</div>
					<div><strong>status:</strong> {selectedDetail.status ?? '-'}</div>
					<div><strong>resultSummary:</strong> {selectedDetail.resultSummary ?? '-'}</div>
					<div><strong>errorReason:</strong> {selectedDetail.errorReason ?? '-'}</div>
				</div>
				<div style="margin-top: 12px;">
					<h3 style="font-size: 0.9rem; margin-bottom: 8px;">Related Logs</h3>
					<table>
						<thead>
							<tr><th>time</th><th>kind</th><th>detail</th></tr>
						</thead>
						<tbody>
							{#if selectedDetail.logs.length === 0}
								<tr><td colspan="3" style="text-align:center; color: #64748b;">No related logs</td></tr>
							{:else}
								{#each selectedDetail.logs as log, index (`${log.ts}-${index}`)}
									<tr>
										<td>{formatTime(log.ts)}</td>
										<td>{log.kind}</td>
										<td class="row-detail">{log.error ?? log.summary ?? log.message ?? '-'}</td>
									</tr>
								{/each}
							{/if}
						</tbody>
					</table>
				</div>
			{:else}
				<div style="color: #475569;">No detail available.</div>
			{/if}
		</aside>
	</div>
{/if}

{#if enqueueOpen}
	<div class="detail-overlay">
		<button type="button" class="detail-backdrop" onclick={closeEnqueueDialog} aria-label="close enqueue dialog"></button>
		<aside class="detail-sheet">
			<div class="detail-header">
				<h2>Enqueue KnowFlow Task</h2>
				<button type="button" onclick={closeEnqueueDialog}>Close</button>
			</div>
			
			<form onsubmit={(e) => { e.preventDefault(); void submitEnqueueTask(); }} style="display: flex; flex-direction: column; gap: 16px; margin-top: 16px;">
				<label style="display: flex; flex-direction: column; gap: 4px;">
					<span style="font-weight: 500;">Topic *</span>
					<input 
						type="text" 
						bind:value={enqueueTopic} 
						placeholder="e.g., PostgreSQL replication" 
						required
						style="padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px;"
					/>
				</label>

				<label style="display: flex; flex-direction: column; gap: 4px;">
					<span style="font-weight: 500;">Mode</span>
					<select bind:value={enqueueMode} style="padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
						<option value="directed">Directed (focused research)</option>
						<option value="expand">Expand (breadth exploration)</option>
						<option value="explore">Explore (deep dive)</option>
					</select>
				</label>

				<label style="display: flex; flex-direction: column; gap: 4px;">
					<span style="font-weight: 500;">Priority</span>
					<input 
						type="number" 
						bind:value={enqueuePriority} 
						min="0" 
						max="100" 
						style="padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px;"
					/>
				</label>

				{#if enqueueError}
					<div class="error-text">{enqueueError}</div>
				{/if}

				{#if enqueueSuccess}
					<div style="color: #059669; padding: 8px 12px; background: #d1fae5; border-radius: 4px;">
						{enqueueSuccess}
					</div>
				{/if}

				<button 
					type="submit" 
					disabled={enqueueLoading || !enqueueTopic.trim()}
					style="padding: 10px 16px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500;"
				>
					{enqueueLoading ? 'Enqueuing...' : 'Enqueue Task'}
				</button>
			</form>
		</aside>
	</div>
{/if}

<style>
.enqueue-btn {
padding: 8px 16px;
background: #10b981;
color: white;
border: none;
border-radius: 8px;
cursor: pointer;
font-size: 0.9rem;
font-weight: 500;
}

.enqueue-btn:hover {
background: #059669;
}
</style>
