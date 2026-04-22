<script lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';
import { fade, fly, slide } from 'svelte/transition';

type MemoryTab = 'episodes' | 'lessons' | 'rules' | 'skills' | 'evaluations';
type GuidanceType = 'rule' | 'skill';
type GuidanceScope = 'always' | 'on_demand';
type LessonType = 'failure' | 'success';

interface KeywordEvaluation {
  id: string;
  runId: string;
  sourceType: 'episode' | 'experience';
  sourceId: string;
  topic: string;
  category: string;
  whyResearch: string;
  searchScore: number;
  termDifficultyScore: number;
  uncertaintyScore: number;
  threshold: number;
  decision: 'enqueued' | 'skipped';
  enqueuedTaskId: string | null;
  modelAlias: string;
  createdAt: string;
}

interface Episode {
  id: string;
  content: string;
  episodeAt: string;
  importance: number;
  sourceTask: string | null;
  createdAt: string;
}

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
  kind: 'episode' | 'lesson' | 'guidance' | 'evaluation';
  id: string;
  label: string;
}

const pageSize = 10;
const tabs: Array<{ id: MemoryTab; label: string; accent: string }> = [
  { id: 'episodes', label: 'ストーリー', accent: '物語' },
  { id: 'lessons', label: '経験', accent: '学習' },
  { id: 'rules', label: '開発ルール', accent: '規約' },
  { id: 'skills', label: '開発ガイド', accent: '手順' },
  { id: 'evaluations', label: 'KnowFlow評価', accent: '選定' },
];

// biome-ignore lint/style/useConst: reassigned by Svelte binding/onclick
let activeTab = $state<MemoryTab>('episodes');
// biome-ignore lint/style/useConst: reassigned by Svelte binding
let searchQuery = $state('');
let currentPage = $state(1);

let episodes = $state<Episode[]>([]);
let lessons = $state<Lesson[]>([]);
let rules = $state<GuidanceItem[]>([]);
let skills = $state<GuidanceItem[]>([]);
let evaluations = $state<KeywordEvaluation[]>([]);

let loadingState = $state<Record<MemoryTab, boolean>>({
  episodes: true,
  lessons: true,
  rules: true,
  skills: true,
  evaluations: true,
});

let errorState = $state<Record<MemoryTab, string | null>>({
  episodes: null,
  lessons: null,
  rules: null,
  skills: null,
  evaluations: null,
});

let toasts = $state<Toast[]>([]);
let toastIdCounter = 0;

let isConsolidating = $state(false);

let detailOpen = $state(false);
let selectedEpisode = $state<Episode | null>(null);

let registerOpen = $state(false);
let registerContent = $state('');
let registerLoading = $state(false);
let registerError = $state<string | null>(null);

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

async function loadEpisodes() {
  setLoading('episodes', true);
  setError('episodes', null);

  try {
    const result = await invoke<Episode[]>('monitor_list_episodes');
    episodes = result.sort(
      (a, b) => new Date(b.episodeAt).getTime() - new Date(a.episodeAt).getTime(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError('episodes', message);
    addToast(`Episodes の読み込みに失敗しました: ${message}`, 'error');
  } finally {
    setLoading('episodes', false);
  }
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

async function loadEvaluations() {
  setLoading('evaluations', true);
  setError('evaluations', null);

  try {
    evaluations = await invoke<KeywordEvaluation[]>('monitor_list_keyword_evaluations');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError('evaluations', message);
    addToast(`Evaluations の読み込みに失敗しました: ${message}`, 'error');
  } finally {
    setLoading('evaluations', false);
  }
}

async function loadAll() {
  await Promise.all([
    loadEpisodes(),
    loadLessons(),
    loadGuidance('rule'),
    loadGuidance('skill'),
    loadEvaluations(),
  ]);
}

const filteredEpisodes = $derived.by(() => {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return episodes;
  return episodes.filter(
    (episode) =>
      episode.content.toLowerCase().includes(query) ||
      episode.id.toLowerCase().includes(query) ||
      episode.sourceTask?.toLowerCase().includes(query),
  );
});

const filteredLessons = $derived.by(() => {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return lessons;
  return lessons.filter(
    (lesson) =>
      lesson.content.toLowerCase().includes(query) ||
      lesson.sessionId.toLowerCase().includes(query) ||
      lesson.scenarioId.toLowerCase().includes(query) ||
      lesson.id.toLowerCase().includes(query) ||
      lesson.failureType?.toLowerCase().includes(query),
  );
});

const filteredRules = $derived.by(() => {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return rules;
  return rules.filter(
    (rule) =>
      rule.title.toLowerCase().includes(query) ||
      rule.content.toLowerCase().includes(query) ||
      rule.tags.some((tag) => tag.toLowerCase().includes(query)) ||
      rule.id.toLowerCase().includes(query),
  );
});

const filteredSkills = $derived.by(() => {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return skills;
  return skills.filter(
    (skill) =>
      skill.title.toLowerCase().includes(query) ||
      skill.content.toLowerCase().includes(query) ||
      skill.tags.some((tag) => tag.toLowerCase().includes(query)) ||
      skill.id.toLowerCase().includes(query),
  );
});

const filteredEvaluations = $derived.by(() => {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return evaluations;
  return evaluations.filter(
    (e) =>
      e.topic.toLowerCase().includes(query) ||
      e.category.toLowerCase().includes(query) ||
      e.whyResearch.toLowerCase().includes(query) ||
      e.id.toLowerCase().includes(query) ||
      e.sourceId.toLowerCase().includes(query),
  );
});

const totalPages = $derived.by(() => {
  const length =
    activeTab === 'episodes'
      ? filteredEpisodes.length
      : activeTab === 'lessons'
        ? filteredLessons.length
        : activeTab === 'rules'
          ? filteredRules.length
          : activeTab === 'skills'
            ? filteredSkills.length
            : filteredEvaluations.length;

  return Math.max(1, Math.ceil(length / pageSize));
});

const paginatedEpisodes = $derived.by(() => {
  const start = (currentPage - 1) * pageSize;
  return filteredEpisodes.slice(start, start + pageSize);
});

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

const paginatedEvaluations = $derived.by(() => {
  const start = (currentPage - 1) * pageSize;
  return filteredEvaluations.slice(start, start + pageSize);
});

const currentError = $derived(errorState[activeTab]);
const currentLoading = $derived(loadingState[activeTab]);

const currentFilteredLength = $derived.by(() => {
  if (activeTab === 'episodes') return filteredEpisodes.length;
  if (activeTab === 'lessons') return filteredLessons.length;
  if (activeTab === 'rules') return filteredRules.length;
  if (activeTab === 'skills') return filteredSkills.length;
  return filteredEvaluations.length;
});

function resetLessonForm() {
  lessonForm = {
    sessionId: 'monitor-manual',
    scenarioId: `manual-${new Date().toISOString().slice(0, 10)}`,
    attempt: 1,
    type: 'failure',
    failureType: '',
    content: '',
    metadataText: '{}',
  };
  lessonFormError = null;
  editingLessonId = null;
}

function resetGuidanceForm(type: GuidanceType) {
  guidanceFormType = type;
  guidanceForm = {
    title: '',
    content: '',
    scope: 'on_demand',
    priority: type === 'rule' ? 80 : 60,
    tagsText: type === 'rule' ? 'rule' : 'skill',
  };
  guidanceFormError = null;
  editingGuidanceId = null;
}

function openDetail(episode: Episode) {
  selectedEpisode = episode;
  detailOpen = true;
}

function closeDetail() {
  selectedEpisode = null;
  detailOpen = false;
}

function openCreateAction() {
  if (activeTab === 'episodes') {
    registerOpen = true;
    registerError = null;
    return;
  }

  if (activeTab === 'lessons') {
    resetLessonForm();
    lessonFormOpen = true;
    return;
  }

  const type = activeTab === 'rules' ? 'rule' : 'skill';
  resetGuidanceForm(type);
  guidanceFormOpen = true;
}

function openEditLesson(lesson: Lesson) {
  editingLessonId = lesson.id;
  lessonForm = {
    sessionId: lesson.sessionId,
    scenarioId: lesson.scenarioId,
    attempt: lesson.attempt,
    type: lesson.type,
    failureType: lesson.failureType ?? '',
    content: lesson.content,
    metadataText: JSON.stringify(lesson.metadata ?? {}, null, 2),
  };
  lessonFormError = null;
  lessonFormOpen = true;
}

function openEditGuidance(item: GuidanceItem) {
  editingGuidanceId = item.id;
  guidanceFormType = item.guidanceType;
  guidanceForm = {
    title: item.title,
    content: item.content,
    scope: item.scope,
    priority: item.priority,
    tagsText: item.tags.join(', '),
  };
  guidanceFormError = null;
  guidanceFormOpen = true;
}

function requestDelete(target: DeleteTarget, event?: Event) {
  event?.stopPropagation();
  deleteTarget = target;
  confirmDeleteOpen = true;
}

async function performDelete() {
  if (!deleteTarget) return;

  const target = deleteTarget;
  deleteTarget = null;
  confirmDeleteOpen = false;
  deletingId = target.id;

  try {
    if (target.kind === 'episode') {
      await invoke('monitor_delete_episode', { id: target.id });
      episodes = episodes.filter((episode) => episode.id !== target.id);
      if (selectedEpisode?.id === target.id) {
        closeDetail();
      }
    } else if (target.kind === 'lesson') {
      await invoke('monitor_delete_lesson', { id: target.id });
      lessons = lessons.filter((lesson) => lesson.id !== target.id);
    } else if (target.kind === 'evaluation') {
      await invoke('monitor_delete_keyword_evaluation', { id: target.id });
      evaluations = evaluations.filter((e) => e.id !== target.id);
    } else {
      await invoke('monitor_delete_guidance', { id: target.id });
      rules = rules.filter((item) => item.id !== target.id);
      skills = skills.filter((item) => item.id !== target.id);
    }

    addToast(`${target.label} を削除しました。`, 'success');
  } catch (error) {
    addToast(
      `削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  } finally {
    deletingId = null;
  }
}

function parseLessonMetadata() {
  if (!lessonForm.metadataText.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(lessonForm.metadataText);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('metadata must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'metadata parse error');
  }
}

async function submitLesson(event: Event) {
  event.preventDefault();
  lessonFormLoading = true;
  lessonFormError = null;

  try {
    const payload = {
      sessionId: lessonForm.sessionId.trim(),
      scenarioId: lessonForm.scenarioId.trim(),
      attempt: lessonForm.attempt,
      type: lessonForm.type,
      failureType: lessonForm.failureType.trim() || null,
      content: lessonForm.content.trim(),
      metadata: parseLessonMetadata(),
    };

    if (editingLessonId) {
      await invoke('monitor_update_lesson', {
        id: editingLessonId,
        payload: JSON.stringify(payload),
      });
      addToast('Lesson を更新しました。', 'success');
    } else {
      await invoke('monitor_create_lesson', {
        payload: JSON.stringify(payload),
      });
      addToast('Lesson を追加しました。', 'success');
    }

    lessonFormOpen = false;
    resetLessonForm();
    await loadLessons();
  } catch (error) {
    lessonFormError = error instanceof Error ? error.message : String(error);
  } finally {
    lessonFormLoading = false;
  }
}

async function submitGuidance(event: Event) {
  event.preventDefault();
  guidanceFormLoading = true;
  guidanceFormError = null;

  try {
    const payload = {
      title: guidanceForm.title.trim(),
      content: guidanceForm.content.trim(),
      guidanceType: guidanceFormType,
      scope: guidanceForm.scope,
      priority: guidanceForm.priority,
      tags: guidanceForm.tagsText
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag, index, values) => tag.length > 0 && values.indexOf(tag) === index),
    };

    if (editingGuidanceId) {
      await invoke('monitor_update_guidance', {
        id: editingGuidanceId,
        payload: JSON.stringify(payload),
      });
      addToast(`${guidanceFormType === 'rule' ? 'Rule' : 'Skill'} を更新しました。`, 'success');
    } else {
      await invoke('monitor_create_guidance', {
        payload: JSON.stringify(payload),
      });
      addToast(`${guidanceFormType === 'rule' ? 'Rule' : 'Skill'} を追加しました。`, 'success');
    }

    guidanceFormOpen = false;
    if (guidanceFormType === 'rule') {
      await loadGuidance('rule');
    } else {
      await loadGuidance('skill');
    }
    resetGuidanceForm(guidanceFormType);
  } catch (error) {
    guidanceFormError = error instanceof Error ? error.message : String(error);
  } finally {
    guidanceFormLoading = false;
  }
}

async function handleRegister(event: Event) {
  event.preventDefault();
  if (!registerContent.trim()) return;

  registerLoading = true;
  registerError = null;

  try {
    const result = await invoke<{
      success: boolean;
      sessionId?: string;
      rawId?: string;
      message?: string;
      error?: string;
    }>('monitor_register_episode', {
      content: registerContent.trim(),
    });

    if (!result.success || !result.sessionId) {
      registerError = result.error || '登録に失敗しました';
      return;
    }

    registerContent = '';
    registerOpen = false;
    addToast('エピソード登録を受け付けました。背後で統合を開始します...', 'info');

    isConsolidating = true;

    invoke<{ success: boolean; episodeId?: string; error?: string }>(
      'monitor_consolidate_session',
      {
        sessionId: result.sessionId,
      },
    )
      .then(async (response) => {
        if (response.success) {
          addToast('ストーリーが正常に統合・生成されました。', 'success');
          await loadEpisodes();
          currentPage = 1;
        } else {
          addToast(`統合はスキップされました: ${response.error}`, 'info');
        }
      })
      .catch((error) => {
        addToast(
          `統合中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      })
      .finally(() => {
        isConsolidating = false;
      });
  } catch (error) {
    registerError = error instanceof Error ? error.message : String(error);
  } finally {
    registerLoading = false;
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncate(text: string, length: number) {
  return text.length <= length ? text : `${text.slice(0, length)}...`;
}

function scopeLabel(scope: GuidanceScope) {
  return scope === 'always' ? 'Always' : 'On demand';
}

function createButtonLabel() {
  if (activeTab === 'episodes') return '新規登録 (LLM統合)';
  if (activeTab === 'lessons') return '経験を追加';
  if (activeTab === 'rules') return 'ルールを追加';
  return 'ガイドを追加';
}

function searchPlaceholder() {
  if (activeTab === 'episodes') return '内容やIDで検索...';
  if (activeTab === 'lessons') return 'session / scenario / 内容で検索...';
  if (activeTab === 'rules') return 'rule のタイトル・タグ・内容で検索...';
  if (activeTab === 'skills') return 'skill のタイトル・タグ・内容で検索...';
  return 'トピックや理由で検索...';
}

onMount(() => {
  void loadAll();
});

$effect(() => {
  activeTab;
  searchQuery;
  currentPage = 1;
});
</script>

<div class="memories-container">
  <header class="page-header">
    <div class="header-content">
      <h1>ナレッジベース管理</h1>
      <p class="subtitle">ストーリー、経験、開発ルール、開発ガイドを管理します。</p>
    </div>

    <div class="header-actions">
      {#if isConsolidating}
        <div class="status-indicator" in:fade>
          <span class="pulse-dot"></span>
          <span class="status-text">ストーリー統合中...</span>
        </div>
      {/if}

      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" bind:value={searchQuery} placeholder={searchPlaceholder()} />
      </div>

      <button class="primary-btn pulse" onclick={openCreateAction}>
        <span class="icon">+</span> {createButtonLabel()}
      </button>
    </div>
  </header>

  <section class="tab-strip shadow-glass">
    {#each tabs as tab}
      <button class="tab-chip" class:active={activeTab === tab.id} onclick={() => activeTab = tab.id}>
        <span>{tab.label}</span>
        <small>{tab.accent}</small>
      </button>
    {/each}
  </section>

  {#if currentError}
    <div class="error-banner" transition:slide>
      <p>{currentError}</p>
      {#if activeTab === 'episodes'}
        <button onclick={loadEpisodes}>再試行</button>
      {:else if activeTab === 'lessons'}
        <button onclick={loadLessons}>再試行</button>
      {:else if activeTab === 'rules'}
        <button onclick={() => loadGuidance('rule')}>再試行</button>
      {:else if activeTab === 'skills'}
        <button onclick={() => loadGuidance('skill')}>再試行</button>
      {:else}
        <button onclick={loadEvaluations}>再試行</button>
      {/if}
    </div>
  {/if}

  <div class="table-container shadow-glass">
    {#if currentLoading}
      <div class="loading-state">
        <div class="spinner"></div>
        <p>読み込み中...</p>
      </div>
    {:else if currentFilteredLength === 0}
      <div class="empty-state" in:fade>
        <div class="empty-icon">📂</div>
        <h3>データが見つかりません</h3>
        <p>{searchQuery ? '検索条件を変えてみてください。' : '右上のボタンから登録できます。'}</p>
      </div>
    {:else}
      <div class="table-wrapper">
        {#if activeTab === 'episodes'}
          <table>
            <thead>
              <tr>
                <th style="width: 140px">日付</th>
                <th style="width: 100px">重要度</th>
                <th style="width: 120px">ソース</th>
                <th>内容</th>
                <th style="width: 120px">操作</th>
              </tr>
            </thead>
            <tbody>
              {#each paginatedEpisodes as episode (episode.id)}
                <tr
                  class="clickable-row"
                  onclick={() => openDetail(episode)}
                  in:fly={{ y: 10, duration: 200 }}
                  out:fade={{ duration: 150 }}
                  class:is-deleting={deletingId === episode.id}
                >
                  <td class="cell-date">{formatDate(episode.episodeAt)}</td>
                  <td class="cell-importance">
                    <div class="importance-cell-track" title={`重要度: ${episode.importance}`}>
                      <div class="importance-cell-fill" style={`width: ${episode.importance * 100}%`}></div>
                    </div>
                  </td>
                  <td>
                    {#if episode.sourceTask}
                      <span class="badge task-badge">{episode.sourceTask.slice(0, 8)}</span>
                    {:else}
                      <span class="muted">-</span>
                    {/if}
                  </td>
                  <td class="cell-content">{truncate(episode.content, 84)}</td>
                  <td class="cell-actions">
                    <button
                      class="icon-btn delete-btn"
                      title="削除"
                      onclick={(event) =>
                        requestDelete(
                          { kind: 'episode', id: episode.id, label: 'Episode' },
                          event,
                        )}
                    >
                      🗑️
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if activeTab === 'lessons'}
          <table>
            <thead>
              <tr>
                <th style="width: 140px">日時</th>
                <th style="width: 150px">セッション</th>
                <th style="width: 150px">シナリオ</th>
                <th style="width: 90px">タイプ</th>
                <th>内容</th>
                <th style="width: 130px">操作</th>
              </tr>
            </thead>
            <tbody>
              {#each paginatedLessons as lesson (lesson.id)}
                <tr
                  class="clickable-row"
                  onclick={() => openEditLesson(lesson)}
                  in:fly={{ y: 10, duration: 200 }}
                  out:fade={{ duration: 150 }}
                  class:is-deleting={deletingId === lesson.id}
                >
                  <td class="cell-date">{formatDate(lesson.createdAt)}</td>
                  <td><span class="badge neutral-badge">{lesson.sessionId}</span></td>
                  <td><span class="badge neutral-badge">{lesson.scenarioId}</span></td>
                  <td>
                    <span class="badge" class:success-badge={lesson.type === 'success'} class:danger-badge={lesson.type === 'failure'}>
                      {lesson.type}
                    </span>
                  </td>
                  <td class="cell-content">{truncate(lesson.content, 84)}</td>
                  <td class="cell-actions inline-actions">
                    <button class="icon-btn" title="編集" onclick={(event) => { event.stopPropagation(); openEditLesson(lesson); }}>✏️</button>
                    <button
                      class="icon-btn delete-btn"
                      title="削除"
                      onclick={(event) =>
                        requestDelete({ kind: 'lesson', id: lesson.id, label: 'Lesson' }, event)}
                    >
                      🗑️
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if activeTab === 'rules' || activeTab === 'skills'}
          <table>
            <thead>
              <tr>
                <th style="width: 160px">日時</th>
                <th style="width: 220px">タイトル</th>
                <th style="width: 110px">Scope</th>
                <th style="width: 100px">Priority</th>
                <th style="width: 180px">Tags</th>
                <th>内容</th>
                <th style="width: 130px">操作</th>
              </tr>
            </thead>
            <tbody>
              {#each (activeTab === 'rules' ? paginatedRules : paginatedSkills) as item (item.id)}
                <tr
                  class="clickable-row"
                  onclick={() => openEditGuidance(item)}
                  in:fly={{ y: 10, duration: 200 }}
                  out:fade={{ duration: 150 }}
                  class:is-deleting={deletingId === item.id}
                >
                  <td class="cell-date">{formatDate(item.createdAt)}</td>
                  <td class="cell-title">
                    <strong>{item.title}</strong>
                    <span class="sub-id">{truncate(item.id, 28)}</span>
                  </td>
                  <td><span class="badge neutral-badge">{scopeLabel(item.scope)}</span></td>
                  <td>
                    <div class="priority-cell">
                      <strong>{item.priority}</strong>
                      <div class="importance-cell-track priority-track">
                        <div class="priority-fill" style={`width: ${Math.min(100, item.priority)}%`}></div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div class="tag-cluster">
                      {#each item.tags.slice(0, 3) as tag}
                        <span class="badge neutral-badge">{tag}</span>
                      {/each}
                      {#if item.tags.length === 0}
                        <span class="muted">-</span>
                      {/if}
                    </div>
                  </td>
                  <td class="cell-content">{truncate(item.content, 76)}</td>
                  <td class="cell-actions inline-actions">
                    <button class="icon-btn" title="編集" onclick={(event) => { event.stopPropagation(); openEditGuidance(item); }}>✏️</button>
                    <button
                      class="icon-btn delete-btn"
                      title="削除"
                      onclick={(event) =>
                        requestDelete(
                          {
                            kind: 'guidance',
                            id: item.id,
                            label: item.guidanceType === 'rule' ? 'Rule' : 'Skill',
                          },
                          event,
                        )}
                    >
                      🗑️
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if activeTab === 'evaluations'}
          <table>
            <thead>
              <tr>
                <th style="width: 140px">日時</th>
                <th style="width: 180px">トピック</th>
                <th style="width: 100px">判定</th>
                <th style="width: 250px">理由</th>
                <th style="width: 100px">スコア計</th>
                <th>モデル</th>
                <th style="width: 80px">操作</th>
              </tr>
            </thead>
            <tbody>
              {#each paginatedEvaluations as ev (ev.id)}
                <tr
                  in:fly={{ y: 10, duration: 200 }}
                  out:fade={{ duration: 150 }}
                  class:is-deleting={deletingId === ev.id}
                >
                  <td class="cell-date">{formatDate(ev.createdAt)}</td>
                  <td>
                    <div class="topic-cell">
                      <strong>{ev.topic}</strong>
                      <span class="badge neutral-badge small-badge">{ev.category}</span>
                    </div>
                  </td>
                  <td>
                    <span class="badge" class:success-badge={ev.decision === 'enqueued'} class:neutral-badge={ev.decision === 'skipped'}>
                      {ev.decision === 'enqueued' ? '採用' : '見送り'}
                    </span>
                  </td>
                  <td class="cell-content" title={ev.whyResearch}>{truncate(ev.whyResearch, 60)}</td>
                  <td>
                    <div class="score-display">
                      <strong>{(ev.searchScore + ev.termDifficultyScore + ev.uncertaintyScore).toFixed(1)}</strong>
                      <small class="muted">/ 30</small>
                    </div>
                  </td>
                  <td><span class="badge neutral-badge">{ev.modelAlias}</span></td>
                  <td class="cell-actions">
                    <button
                      class="icon-btn delete-btn"
                      title="削除"
                      onclick={(event) =>
                        requestDelete(
                          { kind: 'evaluation', id: ev.id, label: 'Evaluation' },
                          event,
                        )}
                    >
                      🗑️
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <footer class="pagination-footer">
        <div class="pagination-info">
          {currentFilteredLength} 件中 {(currentPage - 1) * pageSize + 1} 〜 {Math.min(currentPage * pageSize, currentFilteredLength)} 件を表示
        </div>
        <div class="pagination-controls">
          <button class="control-btn" disabled={currentPage <= 1} onclick={() => currentPage -= 1}>
            前へ
          </button>
          <div class="page-numbers">
            {#each Array.from({ length: totalPages }, (_, index) => index + 1) as page}
              {#if page === 1 || page === totalPages || (page >= currentPage - 1 && page <= currentPage + 1)}
                <button class="page-btn" class:active={currentPage === page} onclick={() => currentPage = page}>
                  {page}
                </button>
              {:else if page === currentPage - 2 || page === currentPage + 2}
                <span class="dots">...</span>
              {/if}
            {/each}
          </div>
          <button class="control-btn" disabled={currentPage >= totalPages} onclick={() => currentPage += 1}>
            次へ
          </button>
        </div>
      </footer>
    {/if}
  </div>

  {#if detailOpen && selectedEpisode}
    <div class="modal-overlay" transition:fade={{ duration: 150 }} onclick={closeDetail} role="presentation">
      <div class="modal-content detail-modal shadow-xl" in:fly={{ y: 20, duration: 300 }} onclick={(event) => event.stopPropagation()} role="presentation">
        <header class="modal-header">
          <div class="modal-title-group">
            <h2>ストーリー詳細</h2>
            <span class="id-tag">ID: {selectedEpisode.id}</span>
          </div>
          <button class="close-btn" onclick={closeDetail}>✕</button>
        </header>

        <div class="modal-scroll-area">
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">発生日時</span>
              <p>{formatDate(selectedEpisode.episodeAt)}</p>
            </div>
            <div class="detail-item">
              <span class="detail-label">重要度</span>
              <div class="importance-row">
                <span class="importance-value">{Math.round(selectedEpisode.importance * 100)}%</span>
                <div class="importance-track large">
                  <div class="importance-fill" style={`width: ${selectedEpisode.importance * 100}%`}></div>
                </div>
              </div>
            </div>
            <div class="detail-item full-width">
              <span class="detail-label">コンテキスト / ソース</span>
              <p>{selectedEpisode.sourceTask || '手動登録 / 未指定'}</p>
            </div>
            <div class="detail-item full-width">
              <span class="detail-label">エピソード内容</span>
              <div class="content-box">{selectedEpisode.content}</div>
            </div>
          </div>
        </div>

        <footer class="modal-footer">
          <button
            class="danger-outline-btn"
            onclick={() => requestDelete({ kind: 'episode', id: selectedEpisode!.id, label: 'Episode' })}
          >
            削除
          </button>
          <button class="secondary-btn" onclick={closeDetail}>閉じる</button>
        </footer>
      </div>
    </div>
  {/if}

  {#if registerOpen}
    <div class="modal-overlay" transition:fade={{ duration: 200 }} onclick={() => !registerLoading && (registerOpen = false)} role="presentation">
      <div class="modal-content shadow-xl" in:fly={{ y: 40, duration: 300 }} onclick={(event) => event.stopPropagation()} role="presentation">
        <h2>新規エピソード登録</h2>
        <p class="modal-hint">入力された体験を LLM が分析し、構造化されたエピソードとして保存します。</p>

        <form onsubmit={handleRegister}>
          <textarea
            bind:value={registerContent}
            placeholder="例: 新しいAPIエンドポイントの実装中に、CORS設定の不備で型エラーが発生したが、ミドルウェアの修正で解決した。"
            disabled={registerLoading}
          ></textarea>

          {#if registerError}
            <p class="form-error">{registerError}</p>
          {/if}

          <div class="modal-actions">
            <button type="button" class="secondary-btn" onclick={() => registerOpen = false} disabled={registerLoading}>
              キャンセル
            </button>
            <button type="submit" class="primary-btn" disabled={registerLoading || !registerContent.trim()}>
              {#if registerLoading}
                <div class="mini-spinner"></div> 統合中...
              {:else}
                LLMで統合して登録
              {/if}
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}

  {#if lessonFormOpen}
    <div class="modal-overlay" transition:fade={{ duration: 200 }} onclick={() => !lessonFormLoading && (lessonFormOpen = false)} role="presentation">
      <div class="modal-content detail-modal shadow-xl" in:fly={{ y: 32, duration: 280 }} onclick={(event) => event.stopPropagation()} role="presentation">
        <header class="modal-header">
          <div class="modal-title-group">
            <h2>{editingLessonId ? '経験ログを編集' : '経験を追加'}</h2>
            <span class="id-tag">経験ログ</span>
          </div>
          <button class="close-btn" onclick={() => lessonFormOpen = false}>✕</button>
        </header>

        <form class="form-stack" onsubmit={submitLesson}>
          <div class="form-grid">
            <label>
              <span>セッションID</span>
              <input type="text" bind:value={lessonForm.sessionId} />
            </label>
            <label>
              <span>シナリオID</span>
              <input type="text" bind:value={lessonForm.scenarioId} />
            </label>
            <label>
              <span>試行回数</span>
              <input type="number" min="1" bind:value={lessonForm.attempt} />
            </label>
            <label>
              <span>結果種別</span>
              <select bind:value={lessonForm.type}>
                <option value="failure">failure (失敗)</option>
                <option value="success">success (成功)</option>
              </select>
            </label>
            <label class="full-width">
              <span>失敗タイプ (任意)</span>
              <input type="text" bind:value={lessonForm.failureType} placeholder="RISK_BLOCKING など" />
            </label>
            <label class="full-width">
              <span>内容</span>
              <textarea bind:value={lessonForm.content} placeholder="試行内容、失敗の原因、解決策など"></textarea>
            </label>
            <label class="full-width">
              <span>メタデータ (JSON)</span>
              <textarea bind:value={lessonForm.metadataText} class="code-textarea" placeholder={'{"source":"monitor"}'}></textarea>
            </label>
          </div>

          {#if lessonFormError}
            <p class="form-error">{lessonFormError}</p>
          {/if}

          <div class="modal-actions">
            <button type="button" class="secondary-btn" onclick={() => lessonFormOpen = false} disabled={lessonFormLoading}>
              キャンセル
            </button>
            <button type="submit" class="primary-btn" disabled={lessonFormLoading || !lessonForm.content.trim()}>
              {#if lessonFormLoading}
                <div class="mini-spinner"></div> 保存中...
              {:else}
                保存
              {/if}
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}

  {#if guidanceFormOpen}
    <div class="modal-overlay" transition:fade={{ duration: 200 }} onclick={() => !guidanceFormLoading && (guidanceFormOpen = false)} role="presentation">
      <div class="modal-content detail-modal shadow-xl" in:fly={{ y: 32, duration: 280 }} onclick={(event) => event.stopPropagation()} role="presentation">
        <header class="modal-header">
          <div class="modal-title-group">
            <h2>{editingGuidanceId ? `${guidanceFormType === 'rule' ? 'ルール' : 'ガイド'}を編集` : `${guidanceFormType === 'rule' ? 'ルール' : 'ガイド'}を追加`}</h2>
            <span class="id-tag">ガイダンス・レジストリ</span>
          </div>
          <button class="close-btn" onclick={() => guidanceFormOpen = false}>✕</button>
        </header>

        <form class="form-stack" onsubmit={submitGuidance}>
          <div class="form-grid">
            <label class="full-width">
              <span>タイトル</span>
              <input type="text" bind:value={guidanceForm.title} />
            </label>
            <label>
              <span>適用スコープ</span>
              <select bind:value={guidanceForm.scope}>
                <option value="on_demand">on_demand (必要時のみ)</option>
                <option value="always">always (常に参照)</option>
              </select>
            </label>
            <label>
              <span>優先度 (0-100)</span>
              <input type="number" min="0" max="100" bind:value={guidanceForm.priority} />
            </label>
            <label class="full-width">
              <span>タグ (カンマ区切り)</span>
              <input type="text" bind:value={guidanceForm.tagsText} placeholder="rule, security, nodejs など" />
            </label>
            <label class="full-width">
              <span>内容 (マークダウン可)</span>
              <textarea bind:value={guidanceForm.content} placeholder="運用ルールや具体的な手順を記述"></textarea>
            </label>
          </div>

          {#if guidanceFormError}
            <p class="form-error">{guidanceFormError}</p>
          {/if}

          <div class="modal-actions">
            <button type="button" class="secondary-btn" onclick={() => guidanceFormOpen = false} disabled={guidanceFormLoading}>
              キャンセル
            </button>
            <button type="submit" class="primary-btn" disabled={guidanceFormLoading || !guidanceForm.title.trim() || !guidanceForm.content.trim()}>
              {#if guidanceFormLoading}
                <div class="mini-spinner"></div> 保存中...
              {:else}
                保存
              {/if}
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}

  {#if confirmDeleteOpen && deleteTarget}
    <div class="modal-overlay z-max" transition:fade={{ duration: 150 }} onclick={() => confirmDeleteOpen = false} role="presentation">
      <div class="modal-content confirm-modal shadow-2xl" in:fly={{ y: 20, duration: 300 }} onclick={(event) => event.stopPropagation()} role="presentation">
        <div class="confirm-icon">⚠️</div>
        <h2>{deleteTarget.label} の削除</h2>
        <p>この操作は取り消せません。対象レコードを完全に削除します。</p>
        <div class="modal-actions">
          <button class="secondary-btn" onclick={() => confirmDeleteOpen = false}>キャンセル</button>
          <button class="danger-btn" onclick={performDelete}>削除する</button>
        </div>
      </div>
    </div>
  {/if}

  <div class="toast-container">
    {#each toasts as toast (toast.id)}
      <div class={`toast toast-${toast.type}`} in:fly={{ x: 50, duration: 300 }} out:fade={{ duration: 200 }}>
        <span class="toast-icon">
          {#if toast.type === 'success'}✅{:else if toast.type === 'error'}❌{:else}ℹ️{/if}
        </span>
        <span class="toast-message">{toast.message}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .memories-container {
    padding: 2rem;
    max-width: 1360px;
    margin: 0 auto;
    font-family: inherit;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 1.5rem;
    gap: 2rem;
    flex-wrap: wrap;
  }

  h1 {
    font-size: 2.5rem;
    font-weight: 900;
    margin: 0;
    letter-spacing: -0.025em;
    background: linear-gradient(135deg, #f8fafc 0%, #94a3b8 100%);
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subtitle {
    color: var(--text-secondary);
    margin-top: 0.5rem;
    font-weight: 500;
  }

  .header-actions {
    display: flex;
    gap: 1rem;
    align-items: center;
    flex-grow: 1;
    justify-content: flex-end;
  }

  .tab-strip {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
    padding: 0.9rem;
    overflow-x: auto;
  }

  .tab-chip {
    min-width: 150px;
    padding: 0.85rem 1rem;
    border-radius: 16px;
    border: 1px solid var(--panel-border);
    background: var(--input-bg);
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    align-items: flex-start;
    transition: all 0.2s;
  }

  .tab-chip small {
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
  }

  .tab-chip.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.22), rgba(16, 185, 129, 0.18));
    border-color: rgba(96, 165, 250, 0.35);
    box-shadow: 0 12px 30px rgba(15, 23, 42, 0.35);
  }

  .search-box {
    position: relative;
    max-width: 420px;
    width: 100%;
  }

  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: #64748b;
    font-size: 0.9rem;
  }

  .search-box input,
  input,
  select,
  textarea {
    width: 100%;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 0.75rem 1rem;
    color: white;
    transition: all 0.2s;
    box-sizing: border-box;
  }

  .search-box input {
    padding-left: 2.5rem;
  }

  .search-box input:focus,
  input:focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-color: #3b82f6;
    background: rgba(255, 255, 255, 0.08);
    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.15);
  }

  textarea {
    min-height: 180px;
    resize: vertical;
    font-family: inherit;
  }

  .code-textarea {
    min-height: 160px;
    font-family: 'SFMono-Regular', ui-monospace, monospace;
    font-size: 0.92rem;
  }

  .primary-btn {
    background: #3b82f6;
    color: white;
    border: none;
    padding: 0.72rem 1.4rem;
    border-radius: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
  }

  .primary-btn:hover {
    background: #2563eb;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
  }

  .secondary-btn,
  .control-btn {
    background: rgba(255, 255, 255, 0.1);
    color: #f1f5f9;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0.65rem 1.1rem;
    border-radius: 10px;
    font-weight: 600;
    cursor: pointer;
  }

  .danger-outline-btn {
    background: transparent;
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: #ef4444;
    padding: 0.6rem 1.2rem;
    border-radius: 10px;
    font-weight: 600;
    cursor: pointer;
  }

  .danger-btn {
    background: #ef4444;
    color: white;
    border: none;
    padding: 0.7rem 1.4rem;
    border-radius: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .shadow-glass {
    background: var(--panel-bg);
    backdrop-filter: blur(20px);
    border: 1px solid var(--panel-border);
    border-radius: 20px;
  }

  .table-container {
    overflow: hidden;
    margin-bottom: 2rem;
  }

  .table-wrapper {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.95rem;
  }

  th {
    text-align: left;
    padding: 1rem 1.5rem;
    color: #64748b;
    font-weight: 600;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  td {
    padding: 1.15rem 1.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    vertical-align: middle;
  }

  .clickable-row {
    cursor: pointer;
    transition: background 0.2s;
  }

  .clickable-row:hover {
    background: rgba(255, 255, 255, 0.02);
  }

  .cell-date {
    font-family: monospace;
    color: #94a3b8;
    white-space: nowrap;
  }

  .cell-importance {
    padding-right: 0;
  }

  .importance-cell-track {
    width: 100%;
    height: 6px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 3px;
    overflow: hidden;
  }

  .importance-cell-fill,
  .priority-fill {
    height: 100%;
    background: linear-gradient(90deg, #10b981, #34d399);
    border-radius: 3px;
  }

  .priority-track {
    margin-top: 0.35rem;
  }

  .priority-fill {
    background: linear-gradient(90deg, #f59e0b, #f97316);
  }

  .priority-cell {
    min-width: 80px;
  }

  .cell-content {
    color: #cbd5e1;
    line-height: 1.5;
  }

  .cell-title strong {
    display: block;
  }

  .sub-id {
    display: block;
    margin-top: 0.35rem;
    color: #64748b;
    font-size: 0.78rem;
    font-family: monospace;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    padding: 0.22rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 700;
    font-family: monospace;
  }

  .neutral-badge {
    background: rgba(148, 163, 184, 0.12);
    color: #cbd5e1;
  }

  .success-badge {
    background: rgba(16, 185, 129, 0.14);
    color: #6ee7b7;
  }

  .danger-badge {
    background: rgba(239, 68, 68, 0.14);
    color: #fda4af;
  }

  .tag-cluster {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .cell-actions {
    text-align: right;
  }

  .inline-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.25rem;
  }

  .icon-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0.5rem;
    border-radius: 8px;
    transition: background 0.2s;
    filter: grayscale(1) opacity(0.6);
  }

  .icon-btn:hover {
    background: rgba(255, 255, 255, 0.05);
    filter: none;
  }

  .topic-cell {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .small-badge {
    padding: 0.1rem 0.4rem;
    font-size: 0.65rem;
    width: fit-content;
  }

  .score-display {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
  }

  .score-display strong {
    font-size: 1.1rem;
    color: #60a5fa;
  }

  .pagination-footer {
    padding: 1rem 1.5rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(0, 0, 0, 0.2);
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .pagination-info {
    font-size: 0.85rem;
    color: #64748b;
  }

  .pagination-controls,
  .page-numbers,
  .modal-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .page-btn {
    min-width: 32px;
    height: 32px;
    background: transparent;
    border: none;
    color: #64748b;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }

  .page-btn.active {
    background: #3b82f6;
    color: white;
  }

  .dots {
    color: #475569;
    padding: 0 0.2rem;
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 23, 0.8);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2000;
    padding: 2rem;
  }

  .modal-content {
    background: #1e293b;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 24px;
    padding: 2rem;
    width: 100%;
    max-width: 650px;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .detail-modal {
    max-width: 860px;
    max-height: 90vh;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .modal-title-group h2 {
    margin: 0;
    font-size: 1.45rem;
  }

  .id-tag {
    font-family: monospace;
    font-size: 0.8rem;
    color: #64748b;
    margin-top: 0.2rem;
    display: block;
  }

  .close-btn {
    background: rgba(255, 255, 255, 0.05);
    border: none;
    color: #94a3b8;
    width: 36px;
    height: 36px;
    border-radius: 12px;
    cursor: pointer;
  }

  .modal-scroll-area {
    overflow-y: auto;
    padding-right: 0.5rem;
  }

  .detail-grid,
  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1.25rem;
  }

  .detail-label,
  label span {
    display: block;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #64748b;
    font-weight: 700;
    margin-bottom: 0.5rem;
    letter-spacing: 0.05em;
  }

  .full-width {
    grid-column: span 2;
  }

  .importance-row {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .importance-value {
    font-weight: 700;
    color: #10b981;
    font-size: 1.1rem;
  }

  .importance-track.large {
    flex-grow: 1;
    height: 8px;
    background: rgba(15, 23, 42, 0.5);
    border-radius: 4px;
    overflow: hidden;
  }

  .content-box {
    background: rgba(15, 23, 42, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.05);
    padding: 1.5rem;
    border-radius: 16px;
    line-height: 1.7;
    color: #e2e8f0;
    white-space: pre-wrap;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    padding-top: 1rem;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .form-stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-error {
    color: #f87171;
    font-size: 0.9rem;
    margin: 0;
  }

  .error-banner {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
    background: rgba(127, 29, 29, 0.25);
    border: 1px solid rgba(248, 113, 113, 0.25);
    border-radius: 16px;
    padding: 1rem 1.25rem;
    margin-bottom: 1rem;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(59, 130, 246, 0.1);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 1.5rem;
  }

  .mini-spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .loading-state,
  .empty-state {
    text-align: center;
    padding: 6rem 1rem;
  }

  .empty-icon {
    font-size: 3.5rem;
    margin-bottom: 1rem;
    opacity: 0.5;
  }

  .empty-state p {
    color: #64748b;
  }

  .muted {
    opacity: 0.4;
  }

  .is-deleting {
    opacity: 0.4;
    pointer-events: none;
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 99px;
  }

  .status-text {
    font-size: 0.85rem;
    font-weight: 500;
    color: #60a5fa;
  }

  .pulse-dot {
    width: 8px;
    height: 8px;
    background-color: #3b82f6;
    border-radius: 50%;
    animation: pulse-dot-anim 2s infinite;
  }

  .toast-container {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    z-index: 9999;
  }

  .toast {
    background: rgba(30, 41, 59, 0.95);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 1rem 1.5rem;
    border-radius: 12px;
    display: flex;
    align-items: center;
    gap: 1rem;
    min-width: 300px;
    max-width: 450px;
  }

  .toast-success {
    border-left: 4px solid #10b981;
  }

  .toast-error {
    border-left: 4px solid #ef4444;
  }

  .toast-info {
    border-left: 4px solid #3b82f6;
  }

  .toast-message {
    font-size: 0.95rem;
    font-weight: 500;
  }

  .confirm-modal {
    max-width: 450px;
    text-align: center;
    padding: 3rem 2rem;
  }

  .confirm-icon {
    font-size: 3rem;
    margin-bottom: 1rem;
  }

  .shadow-xl {
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  }

  .z-max {
    z-index: 3000;
  }

  .pulse {
    animation: pulse 2s infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4);
    }
    70% {
      box-shadow: 0 0 0 10px rgba(59, 130, 246, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
    }
  }

  @keyframes pulse-dot-anim {
    0% {
      transform: scale(0.95);
      box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7);
    }
    70% {
      transform: scale(1);
      box-shadow: 0 0 0 10px rgba(59, 130, 246, 0);
    }
    100% {
      transform: scale(0.95);
      box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
    }
  }

  @media (max-width: 900px) {
    .memories-container {
      padding: 1rem;
    }

    .page-header,
    .header-actions,
    .pagination-footer,
    .form-grid,
    .detail-grid {
      grid-template-columns: 1fr;
      flex-direction: column;
      align-items: stretch;
    }

    .full-width {
      grid-column: span 1;
    }

    .header-actions {
      justify-content: stretch;
    }

    .toast-container {
      left: 1rem;
      right: 1rem;
      bottom: 1rem;
    }

    .toast {
      min-width: auto;
      max-width: none;
    }
  }
</style>
