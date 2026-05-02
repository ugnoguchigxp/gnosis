<script lang="ts">
import { browser } from '$app/environment';
import type {
  SessionDetail,
  SessionDistillationEnqueueResult,
  SessionDistillationListItem,
  SessionDistillationResult,
  SessionDistillationStatus,
  SessionDistillationStatusPayload,
  SessionKnowledgeListPayload,
  SessionMessage,
  SessionSummary,
} from '$lib/monitor/types';
import { invoke } from '@tauri-apps/api/core';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { onMount, tick } from 'svelte';

type MessageOrder = 'asc' | 'desc';
type SessionViewTab = 'conversation' | 'summarize';

let sessions = $state<SessionSummary[]>([]);
let selectedSessionId = $state<string | null>(null);
let selectedDetail = $state<SessionDetail | null>(null);
const filters = $state({ searchQuery: '' });
let sessionsLoading = $state(true);
let summariesLoading = $state(false);
let detailLoading = $state(false);
let distillationLoading = $state(false);
let distillationError = $state<string | null>(null);
let distillationQueueMessage = $state<string | null>(null);
let candidateActionLoading = $state(false);
let distillationStatus = $state<SessionDistillationStatus | null>(null);
let distillationResult = $state<SessionDistillationResult | null>(null);
let sessionsError = $state<string | null>(null);
let summariesError = $state<string | null>(null);
let detailError = $state<string | null>(null);
// biome-ignore lint/style/useConst: tab is switched by button handlers.
let sessionViewTab = $state<SessionViewTab>('conversation');
let sessionSummaries = $state<SessionDistillationListItem[]>([]);
let detailRequestSeq = 0;
let messageOrder = $state<MessageOrder>('asc');
// biome-ignore lint/style/useConst: Svelte bind:this assigns the element reference at runtime.
let messagesElement = $state<HTMLElement | null>(null);
const SIDEBAR_TITLE_LENGTH = 25;

const filteredSessions = $derived.by(() => {
  const query = filters.searchQuery.trim().toLowerCase();
  if (!query) return sessions;
  return sessions.filter((session) =>
    [
      session.title,
      session.source,
      session.sourceId,
      session.sessionFile,
      session.memorySessionId,
      session.preview,
    ]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLowerCase().includes(query)),
  );
});

const renderedMessages = $derived.by(() =>
  (selectedDetail?.messages ?? [])
    .map((message, orderIndex) => ({
      ...message,
      html: renderMarkdown(message.content),
      isAgentInstruction: isAgentInstructionMessage(message.content),
      orderIndex,
      sortTime: messageTimestamp(message.createdAt),
    }))
    .sort((a, b) => {
      const timeDiff = a.sortTime - b.sortTime;
      const directionalTimeDiff = messageOrder === 'asc' ? timeDiff : -timeDiff;
      return directionalTimeDiff || a.orderIndex - b.orderIndex;
    }),
);

const selectedSessionSummaries = $derived.by(() =>
  sessionSummaries.filter((summary) => summary.sessionKey === selectedSessionId),
);

function messageTimestamp(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isAgentInstructionMessage(content: string): boolean {
  return content.trimStart().startsWith('# AGENTS.md instructions for ');
}

function formatSessionAge(value: string): string {
  const date = new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return value;

  const diff = Date.now() - time;
  if (diff < 60_000) return '今';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}時間`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}日`;

  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();
  const currentYear = new Date().getFullYear();
  return year === currentYear ? `${month}/${day}` : `${year}/${month}/${day}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function truncateSidebarTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= SIDEBAR_TITLE_LENGTH) return normalized;
  return `${chars.slice(0, SIDEBAR_TITLE_LENGTH).join('')}...`;
}

function roleLabel(role: SessionMessage['role']): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  return 'Log';
}

function renderMarkdown(content: string): string {
  const html = marked.parse(content, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
  return browser ? DOMPurify.sanitize(html) : html;
}

async function selectSession(session: SessionSummary): Promise<void> {
  selectedSessionId = session.id;
  selectedDetail = null;
  distillationResult = null;
  distillationError = null;
  detailError = null;
  detailLoading = true;
  const requestSeq = ++detailRequestSeq;

  try {
    const detail = await invoke<SessionDetail>('monitor_session_detail', {
      sessionId: session.id,
      session_id: session.id,
    });
    if (requestSeq === detailRequestSeq) {
      selectedDetail = detail;
      detailLoading = false;
      await focusMessageOrderEdge();
      await loadDistillationStatus(session.id);
    }
  } catch (error) {
    if (requestSeq === detailRequestSeq) {
      detailError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (requestSeq === detailRequestSeq) {
      detailLoading = false;
    }
  }
}

async function loadDistillationStatus(sessionId: string): Promise<void> {
  try {
    const payload = await invoke<SessionDistillationStatusPayload | null>(
      'monitor_session_distillation',
      {
        sessionId,
        session_id: sessionId,
      },
    );
    distillationStatus = payload?.record ?? null;
    if (payload?.candidates && payload.candidates.length > 0) {
      distillationResult = {
        distillationId: payload.record.id,
        sessionKey: payload.record.sessionKey,
        status: payload.record.status,
        turnCount: payload.record.turnCount,
        messageCount: payload.record.messageCount,
        keptCount: payload.record.keptCount,
        droppedCount: payload.record.droppedCount,
        promotedCount: payload.candidates.filter((candidate) => Boolean(candidate.promotedNoteId))
          .length,
        modelProvider:
          payload.record.modelProvider === 'openai' ||
          payload.record.modelProvider === 'bedrock' ||
          payload.record.modelProvider === 'local-llm'
            ? payload.record.modelProvider
            : 'deterministic',
        modelName: payload.record.modelName ?? undefined,
        candidates: payload.candidates,
        error: payload.record.error ?? undefined,
      };
    }
  } catch {
    distillationStatus = null;
  }
}

async function runDistillation(promote: boolean): Promise<void> {
  if (!selectedDetail) return;
  distillationLoading = true;
  distillationError = null;
  distillationQueueMessage = null;
  try {
    const queued = await invoke<SessionDistillationEnqueueResult>(
      'monitor_distill_session_knowledge',
      {
        sessionId: selectedDetail.summary.id,
        session_id: selectedDetail.summary.id,
        force: true,
        promote,
      },
    );
    distillationQueueMessage = `queued: ${queued.taskId}`;
    await loadSessionSummaries();
  } catch (error) {
    distillationError = error instanceof Error ? error.message : String(error);
  } finally {
    distillationLoading = false;
  }
}

async function refreshKnowledgeCandidates(): Promise<void> {
  if (!selectedDetail) return;
  const payload = await invoke<SessionKnowledgeListPayload>('monitor_list_session_knowledge', {
    sessionId: selectedDetail.summary.id,
    session_id: selectedDetail.summary.id,
  });
  if (payload.distillation) {
    distillationStatus = payload.distillation;
  }
  if (payload.candidates.length > 0 && payload.distillation) {
    distillationResult = {
      distillationId: payload.distillation.id,
      sessionKey: payload.distillation.sessionKey,
      status: payload.distillation.status,
      turnCount: payload.distillation.turnCount,
      messageCount: payload.distillation.messageCount,
      keptCount: payload.distillation.keptCount,
      droppedCount: payload.distillation.droppedCount,
      promotedCount: payload.candidates.filter((candidate) => Boolean(candidate.promotedNoteId))
        .length,
      modelProvider:
        payload.distillation.modelProvider === 'openai' ||
        payload.distillation.modelProvider === 'bedrock' ||
        payload.distillation.modelProvider === 'local-llm'
          ? payload.distillation.modelProvider
          : 'deterministic',
      modelName: payload.distillation.modelName ?? undefined,
      candidates: payload.candidates,
      error: payload.distillation.error ?? undefined,
    };
  }
}

async function approveCandidate(candidateId: string): Promise<void> {
  candidateActionLoading = true;
  distillationError = null;
  try {
    await invoke('monitor_approve_session_knowledge', { candidateId, candidate_id: candidateId });
    await refreshKnowledgeCandidates();
    await loadSessionSummaries();
  } catch (error) {
    distillationError = error instanceof Error ? error.message : String(error);
  } finally {
    candidateActionLoading = false;
  }
}

async function rejectCandidate(candidateId: string): Promise<void> {
  const reason = prompt('却下理由を入力してください');
  if (!reason || reason.trim().length === 0) return;
  candidateActionLoading = true;
  distillationError = null;
  try {
    await invoke('monitor_reject_session_knowledge', {
      candidateId,
      candidate_id: candidateId,
      reason,
    });
    await refreshKnowledgeCandidates();
    await loadSessionSummaries();
  } catch (error) {
    distillationError = error instanceof Error ? error.message : String(error);
  } finally {
    candidateActionLoading = false;
  }
}

async function recordCandidate(candidateId: string): Promise<void> {
  candidateActionLoading = true;
  distillationError = null;
  try {
    await invoke('monitor_record_session_knowledge', { candidateId, candidate_id: candidateId });
    await refreshKnowledgeCandidates();
    await loadSessionSummaries();
  } catch (error) {
    distillationError = error instanceof Error ? error.message : String(error);
  } finally {
    candidateActionLoading = false;
  }
}

async function setMessageOrder(order: MessageOrder): Promise<void> {
  if (messageOrder === order) return;
  messageOrder = order;
  await focusMessageOrderEdge(order);
}

async function focusMessageOrderEdge(order: MessageOrder = messageOrder): Promise<void> {
  await tick();
  if (!messagesElement) return;

  messagesElement.scrollTop = order === 'asc' ? messagesElement.scrollHeight : 0;
  messagesElement.focus({ preventScroll: true });
}

async function loadSessions(): Promise<void> {
  sessionsLoading = true;
  sessionsError = null;

  try {
    sessions = await invoke<SessionSummary[]>('monitor_list_sessions');
    if (sessions.length > 0) {
      const current = selectedSessionId
        ? sessions.find((session) => session.id === selectedSessionId)
        : sessions[0];
      if (current) {
        await selectSession(current);
      }
    } else {
      selectedSessionId = null;
      selectedDetail = null;
    }
  } catch (error) {
    sessionsError = error instanceof Error ? error.message : String(error);
  } finally {
    sessionsLoading = false;
  }
}

async function loadSessionSummaries(): Promise<void> {
  summariesLoading = true;
  summariesError = null;
  try {
    sessionSummaries = await invoke<SessionDistillationListItem[]>(
      'monitor_list_session_summaries',
    );
  } catch (error) {
    summariesError = error instanceof Error ? error.message : String(error);
  } finally {
    summariesLoading = false;
  }
}

onMount(() => {
  void loadSessions();
  void loadSessionSummaries();
});
</script>

<div class="sessions-page">
  <aside class="session-sidebar" aria-label="Sessions">
    <div class="sidebar-header">
      <h1>Sessions</h1>
      <button
        class="icon-button"
        onclick={async () => {
          await loadSessions();
          await loadSessionSummaries();
        }}
        disabled={sessionsLoading || summariesLoading}
      >
        再読込
      </button>
    </div>

    <input
      class="session-search"
      type="search"
      placeholder="Search sessions"
      value={filters.searchQuery}
      oninput={(event) => {
        filters.searchQuery = (event.currentTarget as HTMLInputElement).value;
      }}
    />

    {#if sessionsError}
      <div class="sidebar-error">{sessionsError}</div>
    {/if}

    <div class="session-list">
      {#if sessionsLoading}
        <div class="sidebar-state">Loading...</div>
      {:else if filteredSessions.length === 0}
        <div class="sidebar-state">No sessions</div>
      {:else}
        {#each filteredSessions as session (session.id)}
          <button
            class="session-item"
            class:selected={selectedSessionId === session.id}
            onclick={() => void selectSession(session)}
            title={session.title}
          >
            <span class="session-title">{truncateSidebarTitle(session.title)}</span>
            <span class="session-age">{formatSessionAge(session.lastSeenAt)}</span>
          </button>
        {/each}
      {/if}
    </div>
  </aside>

  <section class="conversation-pane" aria-label="Session content">
    {#if detailLoading}
      <div class="conversation-state">Loading session...</div>
    {:else if detailError}
      <div class="conversation-state error">{detailError}</div>
    {:else if selectedDetail}
      <header class="conversation-header">
        <div>
          <h2>{selectedDetail.summary.title}</h2>
          <div class="conversation-meta">
            <span>{selectedDetail.summary.source}</span>
            <span>{selectedDetail.summary.messageCount} messages</span>
            <span>{selectedDetail.summary.chunkCount} chunks</span>
            <span>{formatDateTime(selectedDetail.summary.lastSeenAt)}</span>
          </div>
        </div>
        <div class="conversation-actions">
          {#if selectedDetail.summary.sessionFile}
            <div class="session-path" title={selectedDetail.summary.sessionFile}>
              {selectedDetail.summary.sessionFile}
            </div>
          {/if}
        </div>
      </header>

      <div class="session-subtabs" role="tablist" aria-label="Session sub views">
        <button
          type="button"
          role="tab"
          class:active={sessionViewTab === 'conversation'}
          aria-selected={sessionViewTab === 'conversation'}
          onclick={() => {
            sessionViewTab = 'conversation';
          }}
        >
          会話
        </button>
        <button
          type="button"
          role="tab"
          class:active={sessionViewTab === 'summarize'}
          aria-selected={sessionViewTab === 'summarize'}
          onclick={async () => {
            sessionViewTab = 'summarize';
            await refreshKnowledgeCandidates();
          }}
        >
          Summarize
        </button>
      </div>

      {#if sessionViewTab === 'conversation'}
        <section
          class="messages"
          aria-label="Conversation history"
          bind:this={messagesElement}
          tabindex="-1"
        >
          <div class="order-control conversation-order" role="group" aria-label="Message order">
            <button
              type="button"
              class:active={messageOrder === 'asc'}
              aria-pressed={messageOrder === 'asc'}
              onclick={() => void setMessageOrder('asc')}
            >
              古い順
            </button>
            <button
              type="button"
              class:active={messageOrder === 'desc'}
              aria-pressed={messageOrder === 'desc'}
              onclick={() => void setMessageOrder('desc')}
            >
              新しい順
            </button>
          </div>
          {#each renderedMessages as message (message.id)}
            <article class="message" class:user={message.role === 'user'}>
              <div class="message-avatar">{roleLabel(message.role).slice(0, 1)}</div>
              <div class="message-content">
                <div class="message-meta">
                  <span>{roleLabel(message.role)}</span>
                  <span>{formatDateTime(message.createdAt)}</span>
                </div>
                {#if message.isAgentInstruction}
                  <details class="message-accordion">
                    <summary>
                      <span>AGENTS.md instructions</span>
                      <span class="accordion-label show-label">表示</span>
                      <span class="accordion-label hide-label">非表示</span>
                    </summary>
                    <div class="markdown-body">
                      {@html message.html}
                    </div>
                  </details>
                {:else}
                  <div class="markdown-body">
                    {@html message.html}
                  </div>
                {/if}
              </div>
            </article>
          {/each}
        </section>
      {:else}
        <section class="summarize-tab" aria-label="Session summarize view">
          <div class="summaries-header">
            <div class="distillation-actions">
              <button
                type="button"
                class="icon-button"
                onclick={() => void runDistillation(false)}
                disabled={distillationLoading}
              >
                知識抽出
              </button>
              <button
                type="button"
                class="icon-button"
                onclick={() => void runDistillation(true)}
                disabled={distillationLoading}
              >
                昇格まで実行
              </button>
              <button
                type="button"
                class="icon-button"
                onclick={async () => {
                  await loadSessionSummaries();
                  await refreshKnowledgeCandidates();
                }}
                disabled={summariesLoading || candidateActionLoading}
              >
                要約一覧更新
              </button>
            </div>
            <div class="distillation-meta">
              <strong>知識抽出ステータス:</strong>
              <span>{distillationStatus?.status ?? '未生成'}</span>
              {#if distillationStatus}
                <span>keep {distillationStatus.keptCount}</span>
                <span>drop {distillationStatus.droppedCount}</span>
              {/if}
            </div>
          </div>
          {#if distillationError}
            <div class="conversation-state error">{distillationError}</div>
          {/if}
          {#if distillationQueueMessage}
            <div class="conversation-state">{distillationQueueMessage}</div>
          {/if}
          {#if summariesError}
            <div class="conversation-state error">{summariesError}</div>
          {/if}
          <div class="summary-list">
            <h3>要約一覧 ({selectedSessionSummaries.length})</h3>
            {#if summariesLoading}
              <div class="conversation-state">Loading summaries...</div>
            {:else if selectedSessionSummaries.length === 0}
              <div class="conversation-state">No summaries for this session</div>
            {:else}
              {#each selectedSessionSummaries as summary (summary.id)}
                <article class="summary-item">
                  <div class="candidate-head">
                    <span>{summary.status}</span>
                    <span>{summary.modelProvider ?? 'unknown'}</span>
                    {#if summary.modelName}
                      <span>{summary.modelName}</span>
                    {/if}
                  </div>
                  <div class="candidate-foot">
                    <span>id: {summary.id}</span>
                    <span>keep: {summary.keptCount}</span>
                    <span>drop: {summary.droppedCount}</span>
                    <span>created: {formatDateTime(summary.createdAt)}</span>
                    <span>updated: {formatDateTime(summary.updatedAt)}</span>
                  </div>
                  {#if summary.error}
                    <div class="candidate-foot">
                      <span>error: {summary.error}</span>
                    </div>
                  {/if}
                </article>
              {/each}
            {/if}
          </div>

          {#if distillationResult}
            <div class="distillation-candidates">
              {#each distillationResult.candidates as candidate, idx (`${candidate.turnIndex}-${idx}-${candidate.title}`)}
                <article class="candidate-item" class:drop={!candidate.keep}>
                  <div class="candidate-head">
                    <span class="candidate-kind">{candidate.kind}</span>
                    <span class="candidate-keep">{candidate.keep ? 'keep' : 'drop'}</span>
                    <span class="candidate-status">{candidate.status}</span>
                  </div>
                  <h3>{candidate.title}</h3>
                  <p>{candidate.statement}</p>
                  <div class="candidate-foot">
                    <span>理由: {candidate.keepReason}</span>
                    <span>confidence: {candidate.confidence.toFixed(2)}</span>
                    <span>approval: {candidate.approvalStatus ?? 'pending'}</span>
                    {#if candidate.promotedNoteId}
                      <span>promoted: {candidate.promotedNoteId}</span>
                    {/if}
                    {#if candidate.rejectionReason}
                      <span>rejected: {candidate.rejectionReason}</span>
                    {/if}
                    {#if candidate.recordError}
                      <span>recordError: {candidate.recordError}</span>
                    {/if}
                  </div>
                  {#if candidate.id}
                    <div class="candidate-actions">
                      <button
                        type="button"
                        class="icon-button"
                        onclick={() => void approveCandidate(candidate.id!)}
                        disabled={candidateActionLoading || candidate.approvalStatus === 'approved'}
                      >
                        承認
                      </button>
                      <button
                        type="button"
                        class="icon-button"
                        onclick={() => void rejectCandidate(candidate.id!)}
                        disabled={candidateActionLoading || candidate.approvalStatus === 'rejected'}
                      >
                        却下
                      </button>
                      <button
                        type="button"
                        class="icon-button"
                        onclick={() => void recordCandidate(candidate.id!)}
                        disabled={
                          candidateActionLoading ||
                          candidate.approvalStatus !== 'approved' ||
                          Boolean(candidate.promotedNoteId)
                        }
                      >
                        登録
                      </button>
                    </div>
                  {/if}
                  <div class="candidate-foot">
                    {#if Array.isArray(candidate.evidence) && candidate.evidence.length > 0}
                      <span>evidence: {candidate.evidence.length}</span>
                    {/if}
                  </div>
                </article>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    {:else}
      <div class="conversation-state">No session selected</div>
    {/if}
  </section>
</div>

<style>
.sessions-page {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #05070d;
}

.session-sidebar {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid rgba(226, 232, 240, 0.1);
  background: #0b0f18;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1rem;
}

.sidebar-header h1 {
  font-size: 1rem;
  letter-spacing: 0;
}

.icon-button {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.8);
  color: #cbd5e1;
  padding: 0.45rem 0.65rem;
  font-size: 0.8rem;
  cursor: pointer;
}

.icon-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.session-search {
  margin: 0 1rem 0.75rem;
  width: calc(100% - 2rem);
}

.session-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0.25rem 0.5rem 1rem;
}

.session-item {
  width: 100%;
  min-height: 44px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.75rem;
  align-items: center;
  padding: 0.55rem 0.75rem;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.session-item:hover {
  background: rgba(148, 163, 184, 0.08);
}

.session-item.selected {
  background: rgba(59, 130, 246, 0.16);
  border-color: rgba(96, 165, 250, 0.36);
}

.message-avatar {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: #172033;
  color: #dbeafe;
  font-weight: 700;
  font-size: 0.8rem;
}

.session-title {
  color: #f8fafc;
  font-size: 0.95rem;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-age,
.conversation-meta,
.message-meta,
.session-path {
  color: #94a3b8;
  font-size: 0.78rem;
}

.session-age {
  white-space: nowrap;
}

.sidebar-state,
.sidebar-error,
.conversation-state {
  padding: 1rem;
  color: #94a3b8;
  font-size: 0.9rem;
}

.sidebar-error,
.conversation-state.error {
  color: #fecaca;
}

.conversation-pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #060912;
}

.conversation-header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.25rem 2rem;
  border-bottom: 1px solid rgba(226, 232, 240, 0.08);
}

.conversation-header h2 {
  margin: 0 0 0.35rem;
  color: #f8fafc;
  font-size: 1.1rem;
  letter-spacing: 0;
}

.conversation-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.9rem;
}

.conversation-actions {
  min-width: 180px;
  max-width: 42%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.55rem;
}

.distillation-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.session-subtabs {
  display: flex;
  gap: 0.45rem;
  padding: 0.8rem 2rem 0.2rem;
  border-bottom: 1px solid rgba(226, 232, 240, 0.08);
}

.session-subtabs button {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 8px 8px 0 0;
  background: rgba(15, 23, 42, 0.55);
  color: #94a3b8;
  padding: 0.42rem 0.72rem;
  font-size: 0.8rem;
  cursor: pointer;
}

.session-subtabs button.active {
  color: #e2e8f0;
  border-color: rgba(96, 165, 250, 0.38);
  background: rgba(37, 99, 235, 0.2);
}

.summarize-tab {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  padding: 1rem 2rem 2rem;
}

.summaries-header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: center;
  flex-wrap: wrap;
}

.summary-list {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.summary-list h3 {
  margin: 0;
  font-size: 0.9rem;
  color: #cbd5e1;
}

.summary-item {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
  background: rgba(15, 23, 42, 0.45);
}

.distillation-meta {
  display: flex;
  gap: 0.8rem;
  flex-wrap: wrap;
  color: #cbd5e1;
  font-size: 0.82rem;
}

.distillation-candidates {
  display: grid;
  gap: 0.6rem;
  max-height: 280px;
  overflow: auto;
}

.candidate-item {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 8px;
  padding: 0.65rem 0.75rem;
  background: rgba(15, 23, 42, 0.5);
}

.candidate-item.drop {
  opacity: 0.7;
}

.candidate-head {
  display: flex;
  gap: 0.5rem;
  color: #93c5fd;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.candidate-item h3 {
  margin: 0.35rem 0 0.25rem;
  font-size: 0.92rem;
  color: #f8fafc;
}

.candidate-item p {
  margin: 0;
  color: #e2e8f0;
  font-size: 0.86rem;
}

.candidate-foot {
  margin-top: 0.45rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  color: #94a3b8;
  font-size: 0.75rem;
}

.candidate-actions {
  margin-top: 0.45rem;
  display: flex;
  gap: 0.5rem;
}

.order-control {
  display: inline-flex;
  padding: 0.15rem;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.72);
}

.order-control button {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #94a3b8;
  padding: 0.35rem 0.55rem;
  font-size: 0.78rem;
  cursor: pointer;
}

.order-control button.active {
  background: rgba(59, 130, 246, 0.22);
  color: #dbeafe;
}

.session-path {
  align-self: stretch;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 1.5rem 2rem 3rem;
}

.conversation-order {
  margin-bottom: 0.9rem;
}

.message {
  display: grid;
  grid-template-columns: 32px minmax(0, 800px);
  gap: 1rem;
  justify-content: start;
  padding: 1rem 0;
}

.message.user {
  grid-template-columns: minmax(0, 800px) 32px;
  justify-content: end;
}

.message.user .message-avatar {
  grid-column: 2;
  grid-row: 1;
  background: #1e3a2f;
  color: #bbf7d0;
}

.message.user .message-content {
  grid-column: 1;
  grid-row: 1;
  justify-self: end;
  width: fit-content;
  max-width: min(800px, 100%);
  background: rgba(37, 99, 235, 0.18);
  border-color: rgba(96, 165, 250, 0.22);
}

.message-content {
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 0.75rem 1rem;
}

.message-meta {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 0.35rem;
}

.message.user .message-meta {
  justify-content: flex-end;
}

.message-accordion {
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.5);
}

.message-accordion summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.7rem 0.85rem;
  color: #cbd5e1;
  font-size: 0.88rem;
  cursor: pointer;
  list-style: none;
}

.message-accordion summary::-webkit-details-marker {
  display: none;
}

.accordion-label {
  color: #94a3b8;
  font-size: 0.76rem;
}

.hide-label,
.message-accordion[open] .show-label {
  display: none;
}

.message-accordion[open] .hide-label {
  display: inline;
}

.message-accordion[open] summary {
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
}

.message-accordion .markdown-body {
  padding: 0.85rem;
}

.markdown-body {
  color: #e2e8f0;
  font-size: 0.94rem;
  line-height: 1.68;
  overflow-wrap: anywhere;
}

.markdown-body :global(p) {
  margin: 0 0 0.8rem;
}

.markdown-body :global(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :global(pre) {
  overflow: auto;
  padding: 0.8rem;
  border-radius: 8px;
  background: #0f172a;
  border: 1px solid rgba(148, 163, 184, 0.16);
}

.markdown-body :global(code) {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.88em;
}

.markdown-body :global(:not(pre) > code) {
  padding: 0.1rem 0.28rem;
  border-radius: 5px;
  background: rgba(148, 163, 184, 0.16);
}

.markdown-body :global(a) {
  color: #93c5fd;
}

.markdown-body :global(ul),
.markdown-body :global(ol) {
  padding-left: 1.2rem;
}

.markdown-body :global(blockquote) {
  margin: 0.75rem 0;
  padding-left: 0.9rem;
  border-left: 3px solid rgba(148, 163, 184, 0.4);
  color: #cbd5e1;
}

@media (max-width: 820px) {
  .sessions-page {
    grid-template-columns: 1fr;
    grid-template-rows: 42vh minmax(0, 1fr);
  }

  .session-sidebar {
    border-right: 0;
    border-bottom: 1px solid rgba(226, 232, 240, 0.1);
  }

  .conversation-header {
    flex-direction: column;
    padding: 1rem;
  }

  .conversation-actions {
    max-width: 100%;
    align-items: flex-start;
  }

  .session-subtabs {
    padding: 0.7rem 1rem 0.2rem;
  }

  .summarize-tab {
    padding: 0.9rem 1rem 1rem;
  }

  .session-path {
    max-width: 100%;
    text-align: left;
  }

  .messages {
    padding: 1rem;
  }

  .message {
    grid-template-columns: 32px minmax(0, 1fr);
  }

  .message.user {
    grid-template-columns: minmax(0, 1fr) 32px;
  }
}
</style>
