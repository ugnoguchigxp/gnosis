<script lang="ts">
import { MonitorWsClient } from '$lib/monitor/client';
import { createDetailRequestGuard } from '$lib/monitor/detailRequestGuard';
import type {
  ConnectionStatus,
  MonitorConfigResponse,
  MonitorDataInventory,
  MonitorSnapshotData,
  TaskDetailPayload,
  TaskHistoryEntry,
  TaskIndexEntry,
  TimelineEvent,
} from '$lib/monitor/types';
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';

type TimelineStatus =
  | 'done'
  | 'failed'
  | 'deferred'
  | 'pending'
  | 'running'
  | 'review'
  | 'hook'
  | 'unknown';
type EnrichedTimelineEvent = TimelineEvent & {
  status: TimelineStatus;
  source: string | null;
  topic: string | null;
};
type QualityGateKey = keyof MonitorSnapshotData['qualityGates'];

const TIMELINE_PAGE_SIZE = 20;
const TIMELINE_MAX_PAGES = 10;
const TIMELINE_BUFFER_LIMIT = TIMELINE_PAGE_SIZE * TIMELINE_MAX_PAGES;
const DETAIL_CACHE_LIMIT = 50;
const QUALITY_GATE_LABELS: Array<{ key: QualityGateKey; label: string }> = [
  { key: 'doctor', label: 'doctor' },
  { key: 'doctorStrict', label: 'doctor strict' },
  { key: 'onboardingSmoke', label: 'onboarding smoke' },
  { key: 'smoke', label: 'smoke' },
  { key: 'semanticSmoke', label: 'semantic smoke' },
  { key: 'freshCloneValueSmoke', label: 'fresh clone value' },
  { key: 'verifyFast', label: 'verify fast' },
  { key: 'verify', label: 'verify' },
  { key: 'verifyStrict', label: 'verify strict' },
  { key: 'mcpContract', label: 'MCP contract' },
];

const emptyQualityGate = () => ({
  status: 'unknown' as const,
  updatedAtTs: null,
  message: null,
});

const createInitialSnapshot = (): MonitorSnapshotData => ({
  queue: {
    pending: 0,
    running: 0,
    deferred: 0,
    failed: 0,
  },
  embeddingQueue: {
    pending: 0,
    running: 0,
    deferred: 0,
    failed: 0,
  },
  queueInterpretation: {
    runtimeStatus: 'unknown',
    backlogStatus: 'unknown',
    failedCount: 0,
    deferredCount: 0,
    failedReasonClasses: [],
    humanSummary: 'Queue interpretation has not been loaded.',
    nextCommand: 'bun run monitor:snapshot -- --json',
  },
  worker: {
    lastSuccessTs: null,
    lastFailureTs: null,
    consecutiveFailures: 0,
  },
  eval: {
    passRate: 0,
    passed: 0,
    failed: 0,
    updatedAtTs: null,
  },
  automation: {
    automationGate: false,
    backgroundWorkerGate: false,
    localLlmConfigured: false,
    localLlmApiBaseUrl: null,
  },
  knowflow: {
    status: 'unknown',
    lastWorkerTs: null,
    lastWorkerSummary: null,
    lastSeedTs: null,
    lastSeedSummary: null,
    lastKeywordSeedTs: null,
    lastFailureTs: null,
  },
  qualityGates: {
    doctor: emptyQualityGate(),
    doctorStrict: emptyQualityGate(),
    onboardingSmoke: emptyQualityGate(),
    smoke: emptyQualityGate(),
    semanticSmoke: emptyQualityGate(),
    freshCloneValueSmoke: emptyQualityGate(),
    verifyFast: emptyQualityGate(),
    verify: emptyQualityGate(),
    verifyStrict: emptyQualityGate(),
    mcpContract: emptyQualityGate(),
  },
  taskIndex: [],
});

const normalizeSnapshot = (nextSnapshot: MonitorSnapshotData): MonitorSnapshotData => {
  const fallback = createInitialSnapshot();
  return {
    ...fallback,
    ...nextSnapshot,
    qualityGates: {
      ...fallback.qualityGates,
      ...(nextSnapshot.qualityGates ?? {}),
    },
  };
};

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
// biome-ignore lint/style/useConst: $state value is reassigned via tab click handlers
let activeQueueTab = $state<'knowflow' | 'embedding'>('knowflow');

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
let inventory = $state<MonitorDataInventory | null>(null);
let inventoryLoading = $state(false);
let inventoryError = $state<string | null>(null);

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
  if (kind === 'task.pending') return 'pending';
  if (kind === 'task.running') return 'running';
  if (kind === 'review.completed') return 'review';
  if (kind.startsWith('hook.')) return 'hook';
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
      source: event.source ?? taskIndex?.source ?? null,
      topic: event.topic ?? taskIndex?.topic ?? null,
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

const formatBoolean = (value: boolean): string => (value ? 'on' : 'off');

const statusTone = (status: string): string => {
  if (status === 'healthy') return 'connected';
  if (status === 'passed') return 'connected';
  if (status === 'clear') return 'connected';
  if (status === 'degraded') return 'offline';
  if (status === 'failed') return 'offline';
  if (status === 'blocked') return 'offline';
  if (status === 'idle') return 'reconnecting';
  if (status === 'needs_attention') return 'reconnecting';
  return '';
};

const eventDetail = (event: TimelineEvent): string => {
  const parts = [
    event.errorReason,
    event.resultSummary,
    event.message,
    event.gateName ? `gate=${event.gateName}` : undefined,
    event.ruleId ? `rule=${event.ruleId}` : undefined,
    event.traceId ? `trace=${event.traceId}` : undefined,
    event.candidateIds && event.candidateIds.length > 0
      ? `candidates=${event.candidateIds.join(',')}`
      : undefined,
    event.riskTags && event.riskTags.length > 0 ? `risk=${event.riskTags.join(',')}` : undefined,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);

  return parts.length > 0 ? parts.join(' | ') : '-';
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
    inventoryLoading = true;
    inventoryError = null;

    void invoke<MonitorDataInventory>('monitor_data_inventory')
      .then((result) => {
        inventory = result;
      })
      .catch((err) => {
        inventoryError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        inventoryLoading = false;
      });

    // 初期タスク履歴の読み込み (非ブロッキング)
    void invoke<TaskHistoryEntry[]>('monitor_list_tasks')
      .then((initialTasks) => {
        // タイムラインイベント形式に変換して追加
        const initialEvents: TimelineEvent[] = initialTasks.map((t) => ({
          id: `init-${t.id}`,
          kind: `task.${t.status}`,
          ts: new Date(t.updatedAt).getTime(),
          taskId: t.id,
          topic: t.topic,
          source: t.source,
          message: `Initial load: ${t.status}`,
        }));
        // 最新の順に並べて表示 (既存のタイムラインがある場合はマージ)
        const combined = [...initialEvents, ...timeline]
          .sort((a, b) => a.ts - b.ts)
          .slice(-TIMELINE_BUFFER_LIMIT);
        timeline = combined;
      })
      .catch((err) => {
        console.error('Failed to load initial tasks:', err);
      });

    client = new MonitorWsClient({
      callbacks: {
        onSnapshot: (nextSnapshot, ts) => {
          if (!autoUpdate) return;
          snapshot = normalizeSnapshot(nextSnapshot);
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
					<option value="review">review</option>
					<option value="hook">hook</option>
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
			<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
				<h2 style="margin: 0;">Queue</h2>
				<div class="tabs">
					<button 
						type="button" 
						class={`tab-btn ${activeQueueTab === 'knowflow' ? 'active' : ''}`}
						onclick={() => activeQueueTab = 'knowflow'}
					>
						KnowFlow
					</button>
					<button 
						type="button" 
						class={`tab-btn ${activeQueueTab === 'embedding' ? 'active' : ''}`}
						onclick={() => activeQueueTab = 'embedding'}
					>
						Embedding
					</button>
				</div>
			</div>
			
			{#if activeQueueTab === 'knowflow'}
				<div class="stat-row">
					<div class="metric"><div class="metric-label">pending</div><div class="metric-value">{snapshot.queue.pending}</div></div>
					<div class="metric"><div class="metric-label">running</div><div class="metric-value">{snapshot.queue.running}</div></div>
					<div class="metric"><div class="metric-label">deferred</div><div class="metric-value">{snapshot.queue.deferred}</div></div>
					<div class="metric"><div class="metric-label">failed</div><div class="metric-value">{snapshot.queue.failed}</div></div>
				</div>
				<div class="stat-row" style="margin-top: 10px;">
					<div class="metric">
						<div class="metric-label">runtime</div>
						<div class={`badge ${statusTone(snapshot.queueInterpretation.runtimeStatus)}`}>{snapshot.queueInterpretation.runtimeStatus}</div>
					</div>
					<div class="metric">
						<div class="metric-label">backlog</div>
						<div class={`badge ${statusTone(snapshot.queueInterpretation.backlogStatus)}`}>{snapshot.queueInterpretation.backlogStatus}</div>
					</div>
					<div class="metric" style="grid-column: span 2;">
						<div class="metric-label">interpretation</div>
						<div class="metric-value" style="font-size: 0.72rem;">{snapshot.queueInterpretation.humanSummary}</div>
					</div>
				</div>
			{:else}
				<div class="stat-row">
					<div class="metric"><div class="metric-label">pending</div><div class="metric-value">{snapshot.embeddingQueue.pending}</div></div>
					<div class="metric"><div class="metric-label">running</div><div class="metric-value">{snapshot.embeddingQueue.running}</div></div>
					<div class="metric"><div class="metric-label">deferred</div><div class="metric-value">{snapshot.embeddingQueue.deferred}</div></div>
					<div class="metric"><div class="metric-label">failed</div><div class="metric-value">{snapshot.embeddingQueue.failed}</div></div>
				</div>
			{/if}
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
				<div class="metric"><div class="metric-label">pass rate</div><div class="metric-value">{snapshot.eval.passRate.toFixed(2)}%</div></div>
				<div class="metric"><div class="metric-label">passed / failed</div><div class="metric-value">{snapshot.eval.passed} / {snapshot.eval.failed}</div></div>
				<div class="metric" style="grid-column: span 2;"><div class="metric-label">updated</div><div class="metric-value" style="font-size: 0.92rem;">{formatTime(snapshot.eval.updatedAtTs)}</div></div>
			</div>
		</section>

		<section class="panel">
			<h2>Automation</h2>
			<div class="stat-row">
				<div class="metric"><div class="metric-label">automation</div><div class="metric-value">{formatBoolean(snapshot.automation.automationGate)}</div></div>
				<div class="metric"><div class="metric-label">worker gate</div><div class="metric-value">{formatBoolean(snapshot.automation.backgroundWorkerGate)}</div></div>
				<div class="metric"><div class="metric-label">local LLM</div><div class="metric-value">{formatBoolean(snapshot.automation.localLlmConfigured)}</div></div>
				<div class="metric"><div class="metric-label">api</div><div class="metric-value" style="font-size: 0.78rem;">{snapshot.automation.localLlmApiBaseUrl ?? '-'}</div></div>
			</div>
		</section>

		<section class="panel">
			<h2>KnowFlow</h2>
			<div class="stat-row">
				<div class="metric"><div class="metric-label">status</div><div class={`badge ${statusTone(snapshot.knowflow.status)}`}>{snapshot.knowflow.status}</div></div>
				<div class="metric"><div class="metric-label">last worker</div><div class="metric-value" style="font-size: 0.82rem;">{formatTime(snapshot.knowflow.lastWorkerTs)}</div></div>
				<div class="metric"><div class="metric-label">last seed</div><div class="metric-value" style="font-size: 0.82rem;">{formatTime(snapshot.knowflow.lastSeedTs)}</div></div>
				<div class="metric"><div class="metric-label">last failure</div><div class="metric-value" style="font-size: 0.82rem;">{formatTime(snapshot.knowflow.lastFailureTs)}</div></div>
				<div class="metric"><div class="metric-label">phrase scout</div><div class="metric-value" style="font-size: 0.82rem;">{formatTime(snapshot.knowflow.lastKeywordSeedTs)}</div></div>
				<div class="metric" style="grid-column: span 2;"><div class="metric-label">summary</div><div class="metric-value" style="font-size: 0.78rem;">{snapshot.knowflow.lastSeedSummary ?? snapshot.knowflow.lastWorkerSummary ?? '-'}</div></div>
			</div>
		</section>

		<section class="panel">
			<h2>Quality Gates</h2>
			<div class="stat-row">
				{#each QUALITY_GATE_LABELS as gate}
					{@const record = snapshot.qualityGates[gate.key]}
					<div class="metric">
						<div class="metric-label">{gate.label}</div>
						<div class={`badge ${statusTone(record.status)}`}>{record.status}</div>
						<div class="metric-value" style="font-size: 0.72rem; margin-top: 6px;">{formatTime(record.updatedAtTs)}</div>
					</div>
				{/each}
			</div>
		</section>
	</div>

	<section class="panel" style="margin-top: 12px;">
		<h2>Data Inventory</h2>
		{#if inventoryLoading}
			<div style="color: var(--text-muted);">Loading inventory...</div>
		{:else if inventoryError}
			<div class="error-text">{inventoryError}</div>
		{:else if inventory}
			<div class="stat-row" style="margin-bottom: 10px;">
				{#each inventory.signals as signal}
					<div class="metric">
						<div class="metric-label">{signal.label}</div>
						<div class="metric-value">
							{signal.value}{signal.unit === 'percent' ? '%' : ''}
						</div>
					</div>
				{/each}
			</div>
			<table>
				<thead>
					<tr>
						<th>category</th>
						<th>table</th>
						<th>rows</th>
						<th>latest</th>
						<th>state</th>
						<th>status counts</th>
					</tr>
				</thead>
				<tbody>
					{#each inventory.categories as row}
						<tr>
							<td>{row.category}</td>
							<td>{row.table}</td>
							<td>{row.rowCount}</td>
							<td>{row.latestUpdatedAt ? new Date(row.latestUpdatedAt).toLocaleString('ja-JP', { hour12: false }) : '-'}</td>
							<td>{row.maintenanceState}</td>
							<td>{Object.keys(row.statusCounts).length > 0 ? Object.entries(row.statusCounts).map(([key, value]) => `${key}:${value}`).join(', ') : '-'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<div style="color: var(--text-muted);">No inventory data</div>
		{/if}
	</section>

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
					taskId: {selectedEvent.taskId ?? '-'}<br />
					traceId: {selectedEvent.traceId ?? '-'}<br />
					ruleId: {selectedEvent.ruleId ?? '-'}<br />
					gateName: {selectedEvent.gateName ?? '-'}
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

.tabs {
	display: flex;
	gap: 4px;
	background: #f1f5f9;
	padding: 2px;
	border-radius: 6px;
}

.tab-btn {
	padding: 4px 10px;
	font-size: 0.75rem;
	font-weight: 500;
	border: none;
	background: transparent;
	border-radius: 4px;
	cursor: pointer;
	color: #64748b;
	transition: all 0.2s;
}

.tab-btn:hover {
	color: #475569;
}

.tab-btn.active {
	background: white;
	color: #0f172a;
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
</style>
