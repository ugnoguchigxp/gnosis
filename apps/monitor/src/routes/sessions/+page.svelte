<script lang="ts">
import { browser } from '$app/environment';
import type { SessionDetail, SessionMessage, SessionSummary } from '$lib/monitor/types';
import { invoke } from '@tauri-apps/api/core';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { onMount, tick } from 'svelte';

type MessageOrder = 'asc' | 'desc';

let sessions = $state<SessionSummary[]>([]);
let selectedSessionId = $state<string | null>(null);
let selectedDetail = $state<SessionDetail | null>(null);
const filters = $state({ searchQuery: '' });
let sessionsLoading = $state(true);
let detailLoading = $state(false);
let sessionsError = $state<string | null>(null);
let detailError = $state<string | null>(null);
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

onMount(() => {
  void loadSessions();
});
</script>

<div class="sessions-page">
  <aside class="session-sidebar" aria-label="Sessions">
    <div class="sidebar-header">
      <h1>Sessions</h1>
      <button class="icon-button" onclick={() => void loadSessions()} disabled={sessionsLoading}>
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
          <div class="order-control" role="group" aria-label="Message order">
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
          {#if selectedDetail.summary.sessionFile}
            <div class="session-path" title={selectedDetail.summary.sessionFile}>
              {selectedDetail.summary.sessionFile}
            </div>
          {/if}
        </div>
      </header>

      <section
        class="messages"
        aria-label="Conversation history"
        bind:this={messagesElement}
        tabindex="-1"
      >
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
