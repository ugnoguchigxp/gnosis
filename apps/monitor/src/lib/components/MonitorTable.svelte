<script lang="ts" generics="T">
import type { Snippet } from 'svelte';

type SortDirection = 'asc' | 'desc';
type ColumnDef<TItem> = {
  id: string;
  label: string;
  sortable?: boolean;
  sortValue?: (item: TItem) => string | number | null | undefined;
};

const {
  columns,
  items,
  loading = false,
  infoText = null,
  emptyText = 'No data',
  loadingText = 'Loading...',
  pageSize = 25,
  keyOf,
  row,
} = $props<{
  columns: ColumnDef<T>[];
  items: T[];
  loading?: boolean;
  infoText?: string | null;
  emptyText?: string;
  loadingText?: string;
  pageSize?: number;
  keyOf: (item: T, index: number) => string;
  row: Snippet<[T]>;
}>();

let sortBy = $state<string | null>(null);
let sortDirection = $state<SortDirection>('asc');
let currentPage = $state(1);

const sortableColumnIds = $derived(
  columns.filter((c: ColumnDef<T>) => c.sortable).map((c: ColumnDef<T>) => c.id),
);
const activeSortBy = $derived(
  sortBy && sortableColumnIds.includes(sortBy) ? sortBy : sortableColumnIds[0] ?? null,
);

const sortedItems = $derived.by(() => {
  if (!activeSortBy) return items;
  const column = columns.find((c: ColumnDef<T>) => c.id === activeSortBy);
  if (!column?.sortValue) return items;
  const dir = sortDirection === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const left = column.sortValue?.(a);
    const right = column.sortValue?.(b);
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * dir;
    return String(left).localeCompare(String(right), 'ja') * dir;
  });
});

const totalPages = $derived(Math.max(1, Math.ceil(sortedItems.length / pageSize)));
const safePage = $derived(Math.min(currentPage, totalPages));
const pagedItems = $derived(sortedItems.slice((safePage - 1) * pageSize, safePage * pageSize));

const toggleSort = (column: ColumnDef<T>) => {
  if (!column.sortable) return;
  if (sortBy === column.id) {
    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    sortBy = column.id;
    sortDirection = 'asc';
  }
  currentPage = 1;
};
</script>

<section class="panel">
  {#if infoText}
    <div class="table-info">{infoText}</div>
  {/if}
  <table>
    <thead>
      <tr>
        {#each columns as column}
          <th>
            {#if column.sortable}
              <button class="sort-btn" type="button" onclick={() => toggleSort(column)}>
                {column.label}
                {#if activeSortBy === column.id}
                  {sortDirection === 'asc' ? ' ↑' : ' ↓'}
                {/if}
              </button>
            {:else}
              {column.label}
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if loading && items.length === 0}
        <tr>
          <td colspan={columns.length} class="state-cell">{loadingText}</td>
        </tr>
      {:else if items.length === 0}
        <tr>
          <td colspan={columns.length} class="state-cell">{emptyText}</td>
        </tr>
      {:else}
        {#each pagedItems as item, index (keyOf(item, index))}
          <tr>
            {@render row(item)}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
  <div class="pager">
    <div class="pager-meta">rows: {items.length} / page {safePage} of {totalPages}</div>
    <div class="pager-actions">
      <button type="button" class="pager-btn" disabled={safePage <= 1} onclick={() => (currentPage = 1)}>First</button>
      <button
        type="button"
        class="pager-btn"
        disabled={safePage <= 1}
        onclick={() => (currentPage = Math.max(1, safePage - 1))}
      >
        Prev
      </button>
      <button
        type="button"
        class="pager-btn"
        disabled={safePage >= totalPages}
        onclick={() => (currentPage = Math.min(totalPages, safePage + 1))}
      >
        Next
      </button>
      <button
        type="button"
        class="pager-btn"
        disabled={safePage >= totalPages}
        onclick={() => (currentPage = totalPages)}
      >
        Last
      </button>
    </div>
  </div>
</section>

<style>
  .table-info {
    margin-bottom: 8px;
    color: var(--text-muted);
    font-size: 0.82rem;
  }
  .state-cell {
    text-align: center;
    color: var(--text-muted);
    padding: 2rem;
  }
  .sort-btn {
    all: unset;
    cursor: pointer;
  }
  .pager {
    margin-top: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .pager-meta {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .pager-actions {
    display: flex;
    gap: 6px;
  }
  .pager-btn {
    padding: 3px 8px;
    border: 1px solid var(--panel-border);
    background: rgba(15, 23, 42, 0.7);
    color: var(--text-secondary);
    border-radius: 6px;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .pager-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
