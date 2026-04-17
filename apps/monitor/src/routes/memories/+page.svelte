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

let episodes = $state<Episode[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);

// Registration modal state
let registerOpen = $state(false);
let registerContent = $state('');
let registerLoading = $state(false);
let registerError = $state<string | null>(null);

// Deletion state
let deletingId = $state<string | null>(null);

async function loadEpisodes() {
  loading = true;
  error = null;
  try {
    const result = await invoke<Episode[]>('monitor_list_episodes');
    episodes = result;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    loading = false;
  }
}

async function deleteEpisode(id: string) {
  if (!confirm('このエピソードを削除してもよろしいですか？')) return;

  deletingId = id;
  try {
    await invoke('monitor_delete_episode', { id });
    episodes = episodes.filter((e) => e.id !== id);
  } catch (e) {
    alert(`削除に失敗しました: ${e}`);
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
    const result = await invoke<{ success: boolean; episodeId?: string; error?: string }>(
      'monitor_register_episode',
      {
        content: registerContent.trim(),
      },
    );

    if (result.success) {
      registerContent = '';
      registerOpen = false;
      await loadEpisodes(); // 全件リロード
    } else {
      registerError = result.error || '登録に失敗しました（LLM統合エラー）';
    }
  } catch (e) {
    registerError = e instanceof Error ? e.message : String(e);
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

onMount(() => {
  void loadEpisodes();
});
</script>

<div class="memories-container">
  <header class="page-header">
    <div class="header-content">
      <h1>Memory Management</h1>
      <p class="subtitle">過去の経験とストーリーのメンテナス</p>
    </div>
    <button class="primary-btn pulse" onclick={() => registerOpen = true}>
      <span class="icon">+</span> 新規登録 (LLM統合)
    </button>
  </header>

  {#if error}
    <div class="error-banner" transition:slide>
      <p>{error}</p>
      <button onclick={loadEpisodes}>再試行</button>
    </div>
  {/if}

  {#if loading && episodes.length === 0}
    <div class="loading-state">
      <div class="spinner"></div>
      <p>記憶を読み込み中...</p>
    </div>
  {:else if episodes.length === 0}
    <div class="empty-state" in:fade>
      <div class="empty-icon">📂</div>
      <h3>登録されたエピソードがありません</h3>
      <p>右上のボタンから、新しい体験をLLMでストーリー化して登録しましょう。</p>
    </div>
  {:else}
    <div class="episode-grid">
      {#each episodes as episode (episode.id)}
        <article 
          class="episode-card" 
          in:fly={{ y: 20, duration: 400 }}
          class:is-deleting={deletingId === episode.id}
        >
          <div class="card-header">
            <span class="date">{formatDate(episode.episodeAt)}</span>
            {#if episode.sourceTask}
              <span class="badge task-badge">{episode.sourceTask}</span>
            {/if}
            <div class="importance-track">
              <div class="importance-fill" style="width: {episode.importance * 100}%" title="重要度: {episode.importance}"></div>
            </div>
          </div>
          
          <div class="card-body">
            <p>{episode.content}</p>
          </div>

          <div class="card-footer">
            <span class="id-tag">ID: {episode.id.slice(0, 8)}</span>
            <button class="delete-btn" onclick={() => deleteEpisode(episode.id)} disabled={deletingId === episode.id}>
              削除
            </button>
          </div>
        </article>
      {/each}
    </div>
  {/if}

  {#if registerOpen}
    <div class="modal-overlay" transition:fade={{ duration: 200 }}>
      <div class="modal-content" in:fly={{ y: 40, duration: 300 }}>
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
    background: radial-gradient(circle at top right, #1e293b, #0f172a);
    color: #f1f5f9;
  }

  .memories-container {
    padding: 2rem;
    max-width: 1200px;
    margin: 0 auto;
    font-family: 'Inter', sans-serif;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 3rem;
  }

  h1 {
    font-size: 2.5rem;
    font-weight: 800;
    margin: 0;
    background: linear-gradient(to right, #3b82f6, #60a5fa);
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subtitle {
    color: #94a3b8;
    margin-top: 0.5rem;
  }

  /* Buttons */
  .primary-btn {
    background: linear-gradient(135deg, #3b82f6, #2563eb);
    color: white;
    border: none;
    padding: 0.8rem 1.5rem;
    border-radius: 12px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .primary-btn:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 10px 15px -3px rgba(59, 130, 246, 0.4);
  }

  .primary-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .secondary-btn {
    background: rgba(255, 255, 255, 0.05);
    color: #e2e8f0;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0.8rem 1.5rem;
    border-radius: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }

  .secondary-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  /* Grid & Cards */
  .episode-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 1.5rem;
  }

  .episode-card {
    background: rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    position: relative;
    overflow: hidden;
    transition: transform 0.3s, border-color 0.3s;
  }

  .episode-card:hover {
    border-color: rgba(59, 130, 246, 0.3);
    transform: scale(1.02);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.85rem;
    color: #94a3b8;
  }

  .badge {
    background: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
    padding: 0.2rem 0.6rem;
    border-radius: 6px;
    font-weight: 600;
  }

  .importance-track {
    width: 60px;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .importance-fill {
    height: 100%;
    background: #10b981;
  }

  .card-body p {
    margin: 0;
    line-height: 1.6;
    color: #e2e8f0;
    display: -webkit-box;
    line-clamp: 5;
    -webkit-line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: auto;
    padding-top: 1rem;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .id-tag {
    font-family: monospace;
    font-size: 0.75rem;
    color: #64748b;
  }

  .delete-btn {
    background: transparent;
    border: none;
    color: #ef4444;
    font-weight: 600;
    cursor: pointer;
    font-size: 0.9rem;
    opacity: 0.6;
    transition: opacity 0.2s;
  }

  .delete-btn:hover {
    opacity: 1;
    text-decoration: underline;
  }

  /* Modals */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  }

  .modal-content {
    background: #1e293b;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 24px;
    padding: 2rem;
    width: 90%;
    max-width: 600px;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  }

  .modal-hint {
    color: #94a3b8;
    font-size: 0.9rem;
    margin-bottom: 1.5rem;
  }

  textarea {
    width: 100%;
    height: 200px;
    background: rgba(15, 23, 42, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1rem;
    color: white;
    font-family: inherit;
    font-size: 1rem;
    resize: none;
    margin-bottom: 1rem;
  }

  textarea:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
  }

  /* Utils */
  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid rgba(255, 255, 255, 0.1);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: rotate 1s linear infinite;
    margin: 0 auto 1rem;
  }

  .mini-spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: rotate 1s linear infinite;
  }

  @keyframes rotate {
    to { transform: rotate(360deg); }
  }

  .loading-state, .empty-state {
    text-align: center;
    padding: 5rem 0;
    color: #94a3b8;
  }

  .empty-icon {
    font-size: 4rem;
    margin-bottom: 1rem;
  }

  .pulse {
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); }
    70% { box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); }
    100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
  }

  .form-error {
    color: #f87171;
    font-size: 0.9rem;
    margin-bottom: 1rem;
  }

  .is-deleting {
    opacity: 0.5;
    pointer-events: none;
  }
</style>
