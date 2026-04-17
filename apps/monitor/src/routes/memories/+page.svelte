<script lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';
import { fade, fly, slide } from 'svelte/transition';

// TypeScript definitions for the episode data
interface Episode {
  id: string;
  content: string;
  episodeAt: string;
  importance: number;
  sourceTask: string | null;
  createdAt: string;
}

// Data state
let episodes = $state<Episode[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);

// Search & Pagination state
// biome-ignore lint/style/useConst: Svelte 5 $state needs let for bind:value in template
let searchQuery = $state('');
let currentPage = $state(1);
const pageSize = 10;

// Derived states for CRUD
const filteredEpisodes = $derived.by(() => {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return episodes;
  return episodes.filter(
    (e) =>
      e.content.toLowerCase().includes(query) ||
      e.id.toLowerCase().includes(query) ||
      e.sourceTask?.toLowerCase().includes(query),
  );
});

const totalPages = $derived(Math.max(1, Math.ceil(filteredEpisodes.length / pageSize)));
const paginatedEpisodes = $derived.by(() => {
  const start = (currentPage - 1) * pageSize;
  return filteredEpisodes.slice(start, start + pageSize);
});

// Detail modal state
let detailOpen = $state(false);
let selectedEpisode = $state<Episode | null>(null);

// Registration modal state
let registerOpen = $state(false);
let registerContent = $state('');
let registerLoading = $state(false);
let registerError = $state<string | null>(null);

// Confirmation modal state
let confirmDeleteOpen = $state(false);
let idToDelete = $state<string | null>(null);

// Toast state
interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}
let toasts = $state<Toast[]>([]);
let toastIdCounter = 0;

function addToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const id = ++toastIdCounter;
  toasts = [...toasts, { id, message, type }];
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
  }, 5000);
}

// Deletion state
let deletingId = $state<string | null>(null);

// Background processing state
let isConsolidating = $state(false);

async function loadEpisodes() {
  loading = true;
  error = null;
  try {
    const result = await invoke<Episode[]>('monitor_list_episodes');
    // 最新のものを上に
    episodes = result.sort(
      (a, b) => new Date(b.episodeAt).getTime() - new Date(a.episodeAt).getTime(),
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    addToast(`読み込みに失敗しました: ${error}`, 'error');
  } finally {
    loading = false;
  }
}

function requestDelete(id: string, event?: Event) {
  if (event) event.stopPropagation();
  idToDelete = id;
  confirmDeleteOpen = true;
}

async function performDelete() {
  if (!idToDelete) return;
  const id = idToDelete;
  confirmDeleteOpen = false;
  idToDelete = null;

  deletingId = id;
  addToast('エピソードを物理削除しています...', 'info');

  try {
    await invoke('monitor_delete_episode', { id });
    episodes = episodes.filter((e) => e.id !== id);
    addToast('エピソードを正常に削除しました。', 'success');

    if (detailOpen && selectedEpisode?.id === id) {
      closeDetail();
    }
  } catch (e) {
    addToast(`削除に失敗しました: ${e}`, 'error');
  } finally {
    deletingId = null;
  }
}

async function handleRegister(e: Event) {
  e.preventDefault();
  if (!registerContent.trim()) return;

  registerLoading = true;
  registerError = null;
  try {
    // 1. Raw memory を登録 (Fast!)
    const output = await invoke<string>('monitor_register_episode', {
      content: registerContent.trim(),
    });
    const result = JSON.parse(output);

    if (result.success) {
      const sessionId = result.sessionId;
      registerContent = '';
      registerOpen = false; // モーダルを即座に閉じる
      addToast('エピソード登録を受け付けました。背後で統合を開始します...', 'info');

      // 2. 統合処理をバックグラウンドで開始
      isConsolidating = true;

      // 統合コマンドを投げる (await しない)
      invoke<string>('monitor_consolidate_session', { sessionId })
        .then((out) => {
          const res = JSON.parse(out);
          if (res.success) {
            addToast('ストーリーが正常に統合・生成されました。', 'success');
            loadEpisodes();
            currentPage = 1;
          } else {
            addToast(`統合はスキップされました: ${res.error}`, 'info');
          }
        })
        .catch((err) => {
          addToast(`統合中にエラーが発生しました: ${err}`, 'error');
        })
        .finally(() => {
          isConsolidating = false;
        });
    } else {
      registerError = result.error || '登録に失敗しました';
    }
  } catch (e) {
    registerError = e instanceof Error ? e.message : String(e);
  } finally {
    registerLoading = false;
  }
}

function openDetail(episode: Episode) {
  selectedEpisode = episode;
  detailOpen = true;
}

function closeDetail() {
  detailOpen = false;
  selectedEpisode = null;
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
  if (text.length <= length) return text;
  return `${text.slice(0, length)}...`;
}

onMount(() => {
  void loadEpisodes();
});

// Reset page when search changes
$effect(() => {
  searchQuery;
  currentPage = 1;
});
</script>

<div class="memories-container">
  <header class="page-header">
    <div class="header-content">
      <h1>Memory Management</h1>
      <p class="subtitle">過去の経験とストーリーのメンテナス</p>
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
        <input type="text" bind:value={searchQuery} placeholder="内容やIDで検索..." />
      </div>
      <button class="primary-btn pulse" onclick={() => registerOpen = true}>
        <span class="icon">+</span> 新規登録 (LLM統合)
      </button>
    </div>
  </header>

  {#if error}
    <div class="error-banner" transition:slide>
      <p>{error}</p>
      <button onclick={loadEpisodes}>再試行</button>
    </div>
  {/if}

  <div class="table-container shadow-glass">
    {#if loading && episodes.length === 0}
      <div class="loading-state">
        <div class="spinner"></div>
        <p>記憶を読み込み中...</p>
      </div>
    {:else if filteredEpisodes.length === 0}
      <div class="empty-state" in:fade>
        <div class="empty-icon">📂</div>
        <h3>エピソードが見つかりません</h3>
        <p>{searchQuery ? '検索条件を変えてみてください。' : '右上のボタンから新規登録しましょう。'}</p>
      </div>
    {:else}
      <div class="table-wrapper">
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
                  <div class="importance-cell-track" title="重要度: {episode.importance}">
                    <div class="importance-cell-fill" style="width: {episode.importance * 100}%"></div>
                  </div>
                </td>
                <td>
                  {#if episode.sourceTask}
                    <span class="badge task-badge">{episode.sourceTask.slice(0, 8)}</span>
                  {:else}
                    <span class="muted">-</span>
                  {/if}
                </td>
                <td class="cell-content">{truncate(episode.content, 80)}</td>
                <td class="cell-actions">
                  <button class="icon-btn delete-btn" onclick={(e) => requestDelete(episode.id, e)} title="削除">
                    🗑️
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <footer class="pagination-footer">
        <div class="pagination-info">
          Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, filteredEpisodes.length)} of {filteredEpisodes.length} entries
        </div>
        <div class="pagination-controls">
          <button 
            class="control-btn" 
            disabled={currentPage <= 1} 
            onclick={() => currentPage -= 1}
          >
            Previous
          </button>
          <div class="page-numbers">
            {#each Array.from({ length: totalPages }, (_, i) => i + 1) as page}
              {#if page === 1 || page === totalPages || (page >= currentPage - 1 && page <= currentPage + 1)}
                <button 
                  class="page-btn" 
                  class:active={currentPage === page}
                  onclick={() => currentPage = page}
                >
                  {page}
                </button>
              {:else if page === currentPage - 2 || page === currentPage + 2}
                <span class="dots">...</span>
              {/if}
            {/each}
          </div>
          <button 
            class="control-btn" 
            disabled={currentPage >= totalPages} 
            onclick={() => currentPage += 1}
          >
            Next
          </button>
        </div>
      </footer>
    {/if}
  </div>

  <!-- Detail Modal -->
  {#if detailOpen && selectedEpisode}
    <div class="modal-overlay" transition:fade={{ duration: 150 }} onclick={closeDetail} role="presentation">
      <div class="modal-content detail-modal shadow-xl" in:fly={{ y: 20, duration: 300 }} onclick={(e) => e.stopPropagation()} role="presentation">
        <header class="modal-header">
          <div class="modal-title-group">
            <h2>Experience Detail</h2>
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
                  <div class="importance-fill" style="width: {selectedEpisode.importance * 100}%"></div>
                </div>
              </div>
            </div>
            <div class="detail-item full-width">
              <span class="detail-label">コンテキスト / ソース</span>
              <p>{selectedEpisode.sourceTask || '手動登録 / 未指定'}</p>
            </div>
            <div class="detail-item full-width">
              <span class="detail-label">エピソード内容</span>
              <div class="content-box">
                {selectedEpisode.content}
              </div>
            </div>
          </div>
        </div>

        <footer class="modal-footer">
          <button class="danger-outline-btn" onclick={() => requestDelete(selectedEpisode!.id)}>削除</button>
          <button class="secondary-btn" onclick={closeDetail}>閉じる</button>
        </footer>
      </div>
    </div>
  {/if}

  <!-- Confirm Delete Modal -->
  {#if confirmDeleteOpen}
    <div class="modal-overlay z-max" transition:fade={{ duration: 150 }} onclick={() => confirmDeleteOpen = false} role="presentation">
      <div class="modal-content confirm-modal shadow-2xl" in:fly={{ y: 20, duration: 300 }} onclick={(e) => e.stopPropagation()} role="presentation">
        <div class="confirm-icon">⚠️</div>
        <h2>エピソードの物理削除</h2>
        <p>
          この操作は取り消せません。<br/>
          関連する<strong>生メモ、エンティティ、リレーション</strong>もすべて削除されます。
        </p>
        <div class="modal-actions">
          <button class="secondary-btn" onclick={() => confirmDeleteOpen = false}>キャンセル</button>
          <button class="danger-btn" onclick={performDelete}>
            データを完全に削除する
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Toast Notifications -->
  <div class="toast-container">
    {#each toasts as toast (toast.id)}
      <div 
        class="toast toast-{toast.type}" 
        in:fly={{ x: 50, duration: 300 }} 
        out:fade={{ duration: 200 }}
      >
        <span class="toast-icon">
          {#if toast.type === 'success'}✅
          {:else if toast.type === 'error'}❌
          {:else}ℹ️{/if}
        </span>
        <span class="toast-message">{toast.message}</span>
      </div>
    {/each}
  </div>

  <!-- Register Modal -->
  {#if registerOpen}
    <div class="modal-overlay" transition:fade={{ duration: 200 }} onclick={() => !registerLoading && (registerOpen = false)} role="presentation">
      <div class="modal-content shadow-xl" in:fly={{ y: 40, duration: 300 }} onclick={(e) => e.stopPropagation()} role="presentation">
        <h2>新規エピソード登録</h2>
        <p class="modal-hint">入力された体験をLLMが分析し、構造化されたエピソードとして保存します。</p>
        
        <form onsubmit={handleRegister}>
          <textarea 
            bind:value={registerContent} 
            placeholder="例: 新しいAPIエンドポイントの実装中に、CORS設定の不備で型エラーが発生したが、ミドルウェアの修正で解決した。今後は事前に設定ファイルを確認するべきだ..."
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
</div>

<style>
  :global(body) {
    background: radial-gradient(circle at top right, #0f172a, #020617);
    color: #f1f5f9;
    margin: 0;
  }

  .memories-container {
    padding: 2rem;
    max-width: 1300px;
    margin: 0 auto;
    font-family: 'Inter', -apple-system, sans-serif;
  }

  /* Header */
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 2.5rem;
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
    color: #64748b;
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

  .search-box {
    position: relative;
    max-width: 400px;
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

  .search-box input {
    width: 100%;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 0.7rem 1rem 0.7rem 2.5rem;
    color: white;
    transition: all 0.2s;
  }

  .search-box input:focus {
    outline: none;
    border-color: #3b82f6;
    background: rgba(255, 255, 255, 0.08);
    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.15);
  }

  /* UI Components */
  .primary-btn {
    background: #3b82f6;
    color: white;
    border: none;
    padding: 0.7rem 1.4rem;
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

  .secondary-btn {
    background: rgba(255, 255, 255, 0.1);
    color: #f1f5f9;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0.6rem 1.2rem;
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
    transition: all 0.2s;
  }

  .danger-outline-btn:hover {
    background: rgba(239, 68, 68, 0.1);
    border-color: #ef4444;
  }

  .shadow-glass {
    background: rgba(15, 23, 42, 0.6);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
  }

  /* Table */
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
    padding: 1.2rem 1.5rem;
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

  .importance-cell-fill {
    height: 100%;
    background: linear-gradient(90deg, #10b981, #34d399);
    border-radius: 3px;
  }

  .cell-content {
    color: #cbd5e1;
    line-height: 1.5;
  }

  .badge {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    padding: 0.2rem 0.6rem;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 700;
    font-family: monospace;
  }

  .cell-actions {
    text-align: right;
  }

  .icon-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0.5rem;
    border-radius: 8px;
    transition: background 0.2s;
    filter: grayscale(1) opacity(0.5);
  }

  .icon-btn:hover {
    background: rgba(255, 255, 255, 0.05);
    filter: none;
  }

  /* Pagination */
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

  .pagination-controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .control-btn {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.05);
    color: #94a3b8;
    padding: 0.4rem 0.8rem;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .control-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  .control-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .page-numbers {
    display: flex;
    gap: 0.2rem;
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
    transition: all 0.2s;
  }

  .page-btn:hover {
    background: rgba(255, 255, 255, 0.05);
    color: white;
  }

  .page-btn.active {
    background: #3b82f6;
    color: white;
  }

  .dots {
    color: #475569;
    padding: 0 0.2rem;
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
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
    max-width: 800px;
    max-height: 90vh;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .modal-title-group h2 {
    margin: 0;
    font-size: 1.5rem;
    color: white;
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
    font-size: 1rem;
  }

  .modal-scroll-area {
    overflow-y: auto;
    padding-right: 0.5rem;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }

  .detail-item .detail-label {
    display: block;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #64748b;
    font-weight: 700;
    margin-bottom: 0.5rem;
    letter-spacing: 0.05em;
  }

  .detail-item p {
    margin: 0;
    font-weight: 500;
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

  .importance-fill {
    height: 100%;
    background: linear-gradient(90deg, #10b981, #34d399);
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

  textarea {
    width: 100%;
    height: 180px;
    background: rgba(15, 23, 42, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    padding: 1rem;
    color: white;
    font-family: inherit;
    font-size: 1rem;
    resize: none;
    transition: all 0.2s;
  }

  textarea:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1);
  }

  .form-error {
    color: #f87171;
    font-size: 0.9rem;
    margin: 0;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
  }

  /* Status */
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

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .loading-state, .empty-state {
    text-align: center;
    padding: 6rem 1rem;
  }

  .empty-icon {
    font-size: 3.5rem;
    margin-bottom: 1rem;
    opacity: 0.5;
  }

  .empty-state h3 {
    margin: 0 0 0.5rem;
    font-size: 1.25rem;
  }

  .empty-state p {
    color: #64748b;
    margin: 0;
  }

  .is-deleting {
    opacity: 0.4;
    pointer-events: none;
  }

  .muted {
    opacity: 0.3;
  }

  .shadow-xl {
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  }

  /* Confirm Modal Specific */
  .confirm-modal {
    max-width: 450px;
    text-align: center;
    padding: 3rem 2rem;
  }

  .confirm-icon {
    font-size: 3rem;
    margin-bottom: 1rem;
  }

  .z-max {
    z-index: 3000;
  }

  .danger-btn {
    background: #ef4444;
    color: white;
    border: none;
    padding: 0.7rem 1.4rem;
    border-radius: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .danger-btn:hover {
    background: #dc2626;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(220, 38, 38, 0.3);
  }

  /* Toasts */
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
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
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

  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); }
    70% { box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); }
    100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
  }

  .pulse {
    animation: pulse 2s infinite;
  }

  /* Status Indicator Styles */
  .status-indicator {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 99px;
    margin-right: 1rem;
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
    box-shadow: 0 0 0 rgba(59, 130, 246, 0.4);
    animation: pulse-dot-anim 2s infinite;
  }

  @keyframes pulse-dot-anim {
    0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); }
    70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); }
    100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
  }
</style>

