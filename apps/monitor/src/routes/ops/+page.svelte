<main>
  <div class="top-row">
    <div>
      <h1>Ops</h1>
      <div style="margin-top: 4px; font-size: 0.82rem; color: var(--text-muted);">low-frequency operational controls</div>
    </div>
  </div>

  <section class="panel" style="display:grid; gap:10px;">
    <a class="ops-link" href="/ops/sync-state">
      <strong>Sync State</strong>
      <span>Inspect or reset ingestion cursors when sync is stalled or misaligned.</span>
    </a>
  </section>
</main>

<style>
  .ops-link {
    display: grid;
    gap: 4px;
    padding: 12px;
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    text-decoration: none;
    color: var(--text-secondary);
    background: rgba(15, 23, 42, 0.6);
  }
  .ops-link:hover {
    color: var(--text-primary);
    border-color: rgba(148, 163, 184, 0.55);
  }
  .ops-link span {
    font-size: 0.82rem;
    color: var(--text-muted);
  }
</style>
