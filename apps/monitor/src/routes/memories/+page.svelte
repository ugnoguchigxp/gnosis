<script lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';

type MemoryTab = 'lessons' | 'rules' | 'skills';
type GuidanceType = 'rule' | 'skill';
type GuidanceScope = 'always' | 'on_demand';
type LessonType = 'failure' | 'success';

interface Lesson {
  id: string;
  sessionId: string;
  scenarioId: string;
  attempt: number;
  type: LessonType;
  failureType: string | null;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface GuidanceItem {
  id: string;
  title: string;
  content: string;
  guidanceType: GuidanceType;
  scope: GuidanceScope;
  priority: number;
  tags: string[];
  archiveKey: string | null;
  createdAt: string;
}

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface DeleteTarget {
  kind: 'lesson' | 'guidance';
  id: string;
  label: string;
}

const pageSize = 10;
const tabs: Array<{ id: MemoryTab; label: string }> = [
  { id: 'lessons', label: '経験' },
  { id: 'rules', label: '開発ルール' },
  { id: 'skills', label: '開発ガイド' },
];

let activeTab = $state<MemoryTab>('lessons');
let searchQuery = $state('');
let currentPage = $state(1);

let lessons = $state<Lesson[]>([]);
let rules = $state<GuidanceItem[]>([]);
let skills = $state<GuidanceItem[]>([]);

let loadingState = $state<Record<MemoryTab, boolean>>({
  lessons: true,
  rules: true,
  skills: true,
});

let errorState = $state<Record<MemoryTab, string | null>>({
  lessons: null,
  rules: null,
  skills: null,
});

let toasts = $state<Toast[]>([]);
let toastIdCounter = 0;

let lessonFormOpen = $state(false);
let lessonFormLoading = $state(false);
let lessonFormError = $state<string | null>(null);
let editingLessonId = $state<string | null>(null);
let lessonForm = $state({
  sessionId: 'monitor-manual',
  scenarioId: `manual-${new Date().toISOString().slice(0, 10)}`,
  attempt: 1,
  type: 'failure' as LessonType,
  failureType: '',
  content: '',
  metadataText: '{}',
});

let guidanceFormOpen = $state(false);
let guidanceFormLoading = $state(false);
let guidanceFormError = $state<string | null>(null);
let editingGuidanceId = $state<string | null>(null);
let guidanceFormType = $state<GuidanceType>('rule');
let guidanceForm = $state({
  title: '',
  content: '',
  scope: 'on_demand' as GuidanceScope,
  priority: 60,
  tagsText: '',
});

let confirmDeleteOpen = $state(false);
let deleteTarget = $state<DeleteTarget | null>(null);
let deletingId = $state<string | null>(null);

function addToast(message: string, type: Toast['type'] = 'info') {
  const id = ++toastIdCounter;
  toasts = [...toasts, { id, message, type }];
  setTimeout(() => {
    toasts = toasts.filter((toast) => toast.id !== id);
  }, 5000);
}

function setLoading(tab: MemoryTab, loading: boolean) {
  loadingState = { ...loadingState, [tab]: loading };
}

function setError(tab: MemoryTab, message: string | null) {
  errorState = { ...errorState, [tab]: message };
}

async function loadLessons() {
  setLoading('lessons', true);
  setError('lessons', null);

  try {
    lessons = await invoke<Lesson[]>('monitor_list_lessons');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError('lessons', message);
    addToast(`Lessons の読み込みに失敗しました: ${message}`, 'error');
  } finally {
    setLoading('lessons', false);
  }
}

async function loadGuidance(type: GuidanceType) {
  const tab = type === 'rule' ? 'rules' : 'skills';
  setLoading(tab, true);
  setError(tab, null);

  try {
    const result = await invoke<GuidanceItem[]>('monitor_list_guidance', {
      guidanceType: type,
      guidance_type: type,
    });

    if (type === 'rule') {
      rules = result;
    } else {
      skills = result;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(tab, message);
    addToast(
      `${type === 'rule' ? 'Rules' : 'Skills'} の読み込みに失敗しました: ${message}`,
      'error',
    );
  } finally {
    setLoading(tab, false);
  }
}

async function loadAll() {
  await Promise.all([loadLessons(), loadGuidance('rule'), loadGuidance('skill')]);
}

function selectTab(tabId: MemoryTab) {
  activeTab = tabId;
  currentPage = 1;
}

function updateSearchQuery(value: string) {
  searchQuery = value;
  currentPage = 1;
}

const filteredLessons = $derived.by(() => {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return lessons;
  return lessons.filter(
    (lesson) =>
      lesson.content.toLowerCase().includes(query) ||
      lesson.sessionId.toLowerCase().includes(query) ||
      lesson.scenarioId.toLowerCase().includes(query),
  );
});

const filteredRules = $derived.by(() => {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return rules;
  return rules.filter(
    (rule) =>
      rule.title.toLowerCase().includes(query) ||
      rule.content.toLowerCase().includes(query) ||
      rule.tags.some((tag) => tag.toLowerCase().includes(query)),
  );
});

const filteredSkills = $derived.by(() => {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return skills;
  return skills.filter(
    (skill) =>
      skill.title.toLowerCase().includes(query) ||
      skill.content.toLowerCase().includes(query) ||
      skill.tags.some((tag) => tag.toLowerCase().includes(query)),
  );
});

const currentItems = $derived.by(() =>
  activeTab === 'lessons'
    ? filteredLessons
    : activeTab === 'rules'
      ? filteredRules
      : filteredSkills,
);

const totalItems = $derived(currentItems.length);
const totalPages = $derived(Math.max(1, Math.ceil(totalItems / pageSize)));

const paginatedLessons = $derived.by(() => {
  const start = (currentPage - 1) * pageSize;
  return filteredLessons.slice(start, start + pageSize);
});

const paginatedRules = $derived.by(() => {
  const start = (currentPage - 1) * pageSize;
  return filteredRules.slice(start, start + pageSize);
});

const paginatedSkills = $derived.by(() => {
  const start = (currentPage - 1) * pageSize;
  return filteredSkills.slice(start, start + pageSize);
});

$effect(() => {
  currentPage = 1;
  void activeTab;
  void searchQuery;
});

$effect(() => {
  if (currentPage > totalPages) {
    currentPage = totalPages;
  }
});

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ja-JP');
}

function truncate(text: string, max = 72) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function openCreateAction() {
  if (activeTab === 'lessons') {
    editingLessonId = null;
    lessonFormError = null;
    lessonForm = {
      sessionId: 'monitor-manual',
      scenarioId: `manual-${new Date().toISOString().slice(0, 10)}`,
      attempt: 1,
      type: 'failure',
      failureType: '',
      content: '',
      metadataText: '{}',
    };
    lessonFormOpen = true;
    return;
  }

  const type = activeTab === 'rules' ? 'rule' : 'skill';
  openCreateGuidance(type);
}

function openEditLesson(lesson: Lesson) {
  editingLessonId = lesson.id;
  lessonFormError = null;
  lessonForm = {
    sessionId: lesson.sessionId,
    scenarioId: lesson.scenarioId,
    attempt: lesson.attempt,
    type: lesson.type,
    failureType: lesson.failureType ?? '',
    content: lesson.content,
    metadataText: JSON.stringify(lesson.metadata ?? {}, null, 2),
  };
  lessonFormOpen = true;
}

function openCreateGuidance(type: GuidanceType) {
  editingGuidanceId = null;
  guidanceFormType = type;
  guidanceFormError = null;
  guidanceForm = {
    title: '',
    content: '',
    scope: 'on_demand',
    priority: 60,
    tagsText: '',
  };
  guidanceFormOpen = true;
}

function openEditGuidance(item: GuidanceItem) {
  editingGuidanceId = item.id;
  guidanceFormType = item.guidanceType;
  guidanceFormError = null;
  guidanceForm = {
    title: item.title,
    content: item.content,
    scope: item.scope,
    priority: item.priority,
    tagsText: item.tags.join(', '),
  };
  guidanceFormOpen = true;
}

function requestDelete(target: DeleteTarget) {
  deleteTarget = target;
  confirmDeleteOpen = true;
}

async function confirmDelete() {
  const target = deleteTarget;
  if (!target) return;

  deletingId = target.id;

  try {
    if (target.kind === 'lesson') {
      await invoke('monitor_delete_lesson', { id: target.id });
      lessons = lessons.filter((lesson) => lesson.id !== target.id);
    } else {
      await invoke('monitor_delete_guidance', { id: target.id });
      if (target.label === 'Rule') {
        rules = rules.filter((item) => item.id !== target.id);
      } else {
        skills = skills.filter((item) => item.id !== target.id);
      }
    }

    addToast(`${target.label} を削除しました`, 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addToast(`${target.label} の削除に失敗しました: ${message}`, 'error');
  } finally {
    deletingId = null;
    confirmDeleteOpen = false;
    deleteTarget = null;
  }
}

function closeDeleteModal() {
  if (deletingId) return;
  confirmDeleteOpen = false;
  deleteTarget = null;
}

function onBackdropKeydown(event: KeyboardEvent, onClose: () => void) {
  if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onClose();
  }
}

function parseMetadata(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

async function submitLessonForm(event: SubmitEvent) {
  event.preventDefault();
  lessonFormLoading = true;
  lessonFormError = null;

  try {
    const payload = {
      sessionId: lessonForm.sessionId,
      scenarioId: lessonForm.scenarioId,
      attempt: Number(lessonForm.attempt),
      type: lessonForm.type,
      failureType: lessonForm.failureType.trim() || null,
      content: lessonForm.content,
      metadata: parseMetadata(lessonForm.metadataText),
    };

    if (editingLessonId) {
      await invoke('monitor_update_lesson', {
        id: editingLessonId,
        payload: JSON.stringify(payload),
      });
      addToast('Lesson を更新しました', 'success');
    } else {
      await invoke('monitor_create_lesson', {
        payload: JSON.stringify(payload),
      });
      addToast('Lesson を作成しました', 'success');
    }

    await loadLessons();
    lessonFormOpen = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lessonFormError = message;
  } finally {
    lessonFormLoading = false;
  }
}

async function submitGuidanceForm(event: SubmitEvent) {
  event.preventDefault();
  guidanceFormLoading = true;
  guidanceFormError = null;

  try {
    const tags = guidanceForm.tagsText
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);

    const payload = {
      title: guidanceForm.title,
      content: guidanceForm.content,
      guidanceType: guidanceFormType,
      scope: guidanceForm.scope,
      priority: Number(guidanceForm.priority),
      tags,
    };

    if (editingGuidanceId) {
      await invoke('monitor_update_guidance', {
        id: editingGuidanceId,
        payload: JSON.stringify(payload),
      });
      addToast('Guidance を更新しました', 'success');
    } else {
      await invoke('monitor_create_guidance', {
        payload: JSON.stringify(payload),
      });
      addToast('Guidance を作成しました', 'success');
    }

    await loadGuidance(guidanceFormType);
    guidanceFormOpen = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    guidanceFormError = message;
  } finally {
    guidanceFormLoading = false;
  }
}

const createActionLabel = $derived.by(() => {
  if (activeTab === 'lessons') return '経験を追加';
  if (activeTab === 'rules') return 'ルールを追加';
  return 'ガイドを追加';
});

const searchPlaceholder = $derived.by(() => {
  if (activeTab === 'lessons') return 'session / scenario / 内容で検索...';
  if (activeTab === 'rules') return 'rule のタイトル・タグ・内容で検索...';
  return 'skill のタイトル・タグ・内容で検索...';
});

onMount(() => {
  void loadAll();
});
</script>

<div class="memory-page">
  <header class="memory-header">
    <h1>Memory Console</h1>
    <p>Episode 機能は廃止され、再利用可能な知識管理のみを提供します。</p>
  </header>

  <div class="toolbar">
      <div class="tabs">
        {#each tabs as tab}
          <button class="tab-chip" class:active={activeTab === tab.id} onclick={() => selectTab(tab.id)}>
            {tab.label}
          </button>
        {/each}
      </div>

      <div class="actions">
      <input
        type="search"
        value={searchQuery}
        oninput={(event) => updateSearchQuery((event.currentTarget as HTMLInputElement).value)}
        placeholder={searchPlaceholder}
      />
        <button class="btn-primary" onclick={openCreateAction}>
          {createActionLabel}
        </button>
      <button class="btn-secondary" onclick={() => void loadAll()}>再読込</button>
    </div>
  </div>

  {#if errorState[activeTab]}
    <div class="error-banner">{errorState[activeTab]}</div>
  {/if}

  <section class="table-card">
    {#if loadingState[activeTab]}
      <div class="loading">読み込み中...</div>
    {:else if totalItems === 0}
      <div class="empty">データがありません</div>
    {:else}
      {#if activeTab === 'lessons'}
        <table>
          <thead>
            <tr><th>日時</th><th>Session</th><th>Scenario</th><th>Type</th><th>内容</th><th></th></tr>
          </thead>
          <tbody>
            {#each paginatedLessons as lesson (lesson.id)}
              <tr>
                <td>{formatDate(lesson.createdAt)}</td>
                <td>{lesson.sessionId}</td>
                <td>{lesson.scenarioId}</td>
                <td>{lesson.type}</td>
                <td>{truncate(lesson.content)}</td>
                <td>
                  <button onclick={() => openEditLesson(lesson)}>編集</button>
                  <button
                    class="danger"
                    disabled={deletingId === lesson.id}
                    onclick={() => requestDelete({ kind: 'lesson', id: lesson.id, label: 'Lesson' })}
                  >削除</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else if activeTab === 'rules' || activeTab === 'skills'}
        <table>
          <thead>
            <tr><th>日時</th><th>Title</th><th>Scope</th><th>Priority</th><th>Tags</th><th></th></tr>
          </thead>
          <tbody>
            {#each (activeTab === 'rules' ? paginatedRules : paginatedSkills) as item (item.id)}
              <tr>
                <td>{formatDate(item.createdAt)}</td>
                <td>{item.title}</td>
                <td>{item.scope}</td>
                <td>{item.priority}</td>
                <td>{item.tags.join(', ')}</td>
                <td>
                  <button onclick={() => openEditGuidance(item)}>編集</button>
                  <button
                    class="danger"
                    disabled={deletingId === item.id}
                    onclick={() =>
                      requestDelete({
                        kind: 'guidance',
                        id: item.id,
                        label: activeTab === 'rules' ? 'Rule' : 'Skill',
                      })}
                  >削除</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      <div class="pagination">
        <button disabled={currentPage <= 1} onclick={() => currentPage--}>前へ</button>
        <span>{currentPage} / {totalPages}</span>
        <button disabled={currentPage >= totalPages} onclick={() => currentPage++}>次へ</button>
      </div>
    {/if}
  </section>
</div>

{#if lessonFormOpen}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    onclick={() => !lessonFormLoading && (lessonFormOpen = false)}
    onkeydown={(event) =>
      onBackdropKeydown(event, () => {
        if (!lessonFormLoading) lessonFormOpen = false;
      })}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      <h2>{editingLessonId ? 'Lesson 編集' : 'Lesson 追加'}</h2>
      <form onsubmit={submitLessonForm}>
        <label>Session ID<input bind:value={lessonForm.sessionId} required /></label>
        <label>Scenario ID<input bind:value={lessonForm.scenarioId} required /></label>
        <label>Attempt<input type="number" bind:value={lessonForm.attempt} min="1" required /></label>
        <label>Type
          <select bind:value={lessonForm.type}>
            <option value="failure">failure</option>
            <option value="success">success</option>
          </select>
        </label>
        <label>Failure Type<input bind:value={lessonForm.failureType} /></label>
        <label>Content<textarea bind:value={lessonForm.content} rows="6" required></textarea></label>
        <label>Metadata(JSON)<textarea bind:value={lessonForm.metadataText} rows="5"></textarea></label>
        {#if lessonFormError}<p class="error-text">{lessonFormError}</p>{/if}
        <div class="form-actions">
          <button type="button" onclick={() => (lessonFormOpen = false)} disabled={lessonFormLoading}>キャンセル</button>
          <button type="submit" disabled={lessonFormLoading}>{lessonFormLoading ? '保存中...' : '保存'}</button>
        </div>
      </form>
    </div>
  </div>
{/if}

{#if guidanceFormOpen}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    onclick={() => !guidanceFormLoading && (guidanceFormOpen = false)}
    onkeydown={(event) =>
      onBackdropKeydown(event, () => {
        if (!guidanceFormLoading) guidanceFormOpen = false;
      })}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      <h2>{editingGuidanceId ? 'Guidance 編集' : 'Guidance 追加'}</h2>
      <form onsubmit={submitGuidanceForm}>
        <label>Type
          <select bind:value={guidanceFormType} disabled={Boolean(editingGuidanceId)}>
            <option value="rule">rule</option>
            <option value="skill">skill</option>
          </select>
        </label>
        <label>Title<input bind:value={guidanceForm.title} required /></label>
        <label>Content<textarea bind:value={guidanceForm.content} rows="8" required></textarea></label>
        <label>Scope
          <select bind:value={guidanceForm.scope}>
            <option value="always">always</option>
            <option value="on_demand">on_demand</option>
          </select>
        </label>
        <label>Priority<input type="number" bind:value={guidanceForm.priority} min="0" max="100" /></label>
        <label>Tags(,区切り)<input bind:value={guidanceForm.tagsText} /></label>
        {#if guidanceFormError}<p class="error-text">{guidanceFormError}</p>{/if}
        <div class="form-actions">
          <button type="button" onclick={() => (guidanceFormOpen = false)} disabled={guidanceFormLoading}>キャンセル</button>
          <button type="submit" disabled={guidanceFormLoading}>{guidanceFormLoading ? '保存中...' : '保存'}</button>
        </div>
      </form>
    </div>
  </div>
{/if}

{#if confirmDeleteOpen && deleteTarget}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    onclick={closeDeleteModal}
    onkeydown={(event) => onBackdropKeydown(event, closeDeleteModal)}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      <h2>削除確認</h2>
      <p>{deleteTarget.label} ({deleteTarget.id}) を削除します。元に戻せません。</p>
      <div class="form-actions">
        <button onclick={closeDeleteModal} disabled={Boolean(deletingId)}>キャンセル</button>
        <button class="danger" onclick={confirmDelete} disabled={Boolean(deletingId)}>{deletingId ? '削除中...' : '削除'}</button>
      </div>
    </div>
  </div>
{/if}

<div class="toast-stack">
  {#each toasts as toast (toast.id)}
    <div class={`toast ${toast.type}`}>{toast.message}</div>
  {/each}
</div>

<style>
  .memory-page { padding: 1rem; display: grid; gap: 1rem; color: #e5e7eb; }
  .memory-header h1 { margin: 0; }
  .memory-header p { margin: 0.25rem 0 0; color: #9ca3af; }
  .toolbar { display: grid; gap: 0.75rem; }
  .tabs { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .tab-chip {
    border: 1px solid #4b5563;
    border-radius: 999px;
    padding: 0.4rem 0.8rem;
    background: #111827;
    color: #d1d5db;
    font-weight: 600;
  }
  .tab-chip.active { background: #f9fafb; color: #111827; border-color: #f9fafb; }
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .actions input {
    min-width: 260px;
    padding: 0.5rem;
    background: #0f172a;
    color: #e5e7eb;
    border: 1px solid #475467;
    border-radius: 8px;
  }
  .actions input::placeholder { color: #9ca3af; }
  .btn-primary, .btn-secondary {
    padding: 0.5rem 0.75rem;
    background: #1f2937;
    color: #f9fafb;
    border: 1px solid #4b5563;
    border-radius: 8px;
  }
  .btn-primary:hover, .btn-secondary:hover { background: #374151; }
  .table-card { border: 1px solid #374151; border-radius: 10px; overflow: hidden; background: #0b1220; }
  table { width: 100%; border-collapse: collapse; color: #e5e7eb; }
  th, td { padding: 0.5rem; border-bottom: 1px solid #1f2937; text-align: left; vertical-align: top; }
  th { background: #111827; color: #cbd5e1; font-weight: 700; letter-spacing: 0.04em; }
  tbody tr:nth-child(even) { background: #0f172a; }
  .loading, .empty { padding: 1rem; color: #9ca3af; }
  .pagination { display: flex; justify-content: center; gap: 0.5rem; padding: 0.75rem; }
  button { background: #1f2937; color: #f9fafb; border: 1px solid #4b5563; border-radius: 8px; padding: 0.35rem 0.65rem; }
  button:hover { background: #374151; }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  button.danger { color: #fda4af; border-color: #7f1d1d; background: #2b1114; }
  button.danger:hover { background: #3b141a; }
  .error-banner { color: #fecaca; border: 1px solid #7f1d1d; background: #2b1114; padding: 0.5rem; border-radius: 6px; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(2, 6, 23, 0.72); display: grid; place-items: center; z-index: 1000; }
  .modal { width: min(760px, calc(100vw - 2rem)); background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 1rem; display: grid; gap: 0.75rem; color: #e5e7eb; }
  form { display: grid; gap: 0.75rem; }
  label { display: grid; gap: 0.35rem; font-size: 0.92rem; color: #cbd5e1; }
  input, textarea, select { padding: 0.5rem; border: 1px solid #475467; border-radius: 6px; font: inherit; background: #020617; color: #e5e7eb; }
  .form-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .error-text { color: #fca5a5; margin: 0; }
  .toast-stack { position: fixed; right: 1rem; bottom: 1rem; display: grid; gap: 0.4rem; z-index: 1200; }
  .toast { padding: 0.6rem 0.75rem; border-radius: 6px; color: #fff; font-size: 0.9rem; }
  .toast.info { background: #1565c0; }
  .toast.success { background: #2e7d32; }
  .toast.error { background: #c62828; }
</style>
