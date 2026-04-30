<script lang="ts">
import type { Entity, Relation } from '$lib/monitor/types';
import { invoke } from '@tauri-apps/api/core';
import * as d3 from 'd3';
import { onMount } from 'svelte';

type GraphNode = d3.SimulationNodeDatum &
  Entity & {
    referenceCount: number;
  };

type GraphLink = d3.SimulationLinkDatum<GraphNode> &
  Relation & {
    id: string;
  };

type ClassificationRelationType = 'applies_to_technology' | 'belongs_to_concept' | 'related_to';

type ClassificationPreviewStatus = 'create' | 'skip-existing' | 'skip-self' | 'skip-missing';

type ClassificationPreviewItem = {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  relationType: ClassificationRelationType;
  status: ClassificationPreviewStatus;
  reason: string;
};

type ClassificationResult = {
  created: number;
  skipped: number;
  failed: Array<{ item: ClassificationPreviewItem; error: string }>;
};

type GraphSnapshot = {
  entities: Array<Entity & { referenceCount: number }>;
  relations: Array<Relation & { id: string }>;
  communities: Array<{ id: string; summary: string | null; memberCount: number }>;
  stats: {
    totalEntities: number;
    totalRelations: number;
    totalCommunities: number;
    totalEntitiesInDb: number;
    totalRelationsInDb: number;
    totalCommunitiesInDb: number;
    limitApplied: boolean;
  };
};

let graphData = $state<GraphSnapshot | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let svgContainer: SVGSVGElement;

let selectedNodeId = $state<string | null>(null);
const selectedNode = $derived(graphData?.entities.find((e) => e.id === selectedNodeId) || null);
let showDeleteConfirm = $state(false);
let formLoading = $state(false);
let formError = $state<string | null>(null);
let editForm = $state({
  name: '',
  type: '',
  description: '',
  confidence: 0.5,
  scope: 'on_demand',
});

let classificationMode = $state(false);
let selectedClassificationIds = $state<string[]>([]);
let classificationTargetId = $state('');
let classificationRelationType = $state<ClassificationRelationType>('applies_to_technology');
let classificationWeight = $state(1);
let classificationLoading = $state(false);
let classificationError = $state<string | null>(null);
let classificationRelationKeys = $state<string[]>([]);
let classificationRelationsChecked = $state(false);
let classificationResult = $state<ClassificationResult | null>(null);

const MAX_NODE_LABEL_CHARS = 20;

const truncateNodeLabel = (value: string, maxLength = MAX_NODE_LABEL_CHARS) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizedWeight = (link: GraphLink) => clamp(Number(link.weight || 1), 0.1, 3);

const relationKey = (sourceId: string, targetId: string, relationType: string) =>
  `${sourceId}\u0000${targetId}\u0000${relationType}`;

const metadataStringArray = (metadata: Record<string, unknown>, key: string) => {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter((item) => item.length > 0)
    : [];
};

const isTechnologyConcept = (entity: Entity | null) => {
  if (!entity || entity.type !== 'concept') return false;
  const conceptKind =
    typeof entity.metadata.conceptKind === 'string' ? entity.metadata.conceptKind : '';
  const source = typeof entity.metadata.source === 'string' ? entity.metadata.source : '';
  const tags = metadataStringArray(entity.metadata, 'tags');
  return (
    conceptKind === 'technology' || source === 'technology_seed' || tags.includes('technology')
  );
};

const getEntityById = (id: string) =>
  graphData?.entities.find((entity) => entity.id === id) || null;

const getConceptNodes = () =>
  [...(graphData?.entities ?? [])]
    .filter((entity) => entity.type === 'concept')
    .sort((a, b) => a.name.localeCompare(b.name));

const getSelectedClassificationNodes = () => {
  const selectedIds = new Set(selectedClassificationIds);
  return (graphData?.entities ?? [])
    .filter((entity) => selectedIds.has(entity.id))
    .sort((a, b) => a.name.localeCompare(b.name));
};

const existingRelationKeySet = () => {
  const keys = new Set(classificationRelationKeys);
  for (const relation of graphData?.relations ?? []) {
    keys.add(relationKey(relation.sourceId, relation.targetId, relation.relationType));
  }
  return keys;
};

const getClassificationPreview = (): ClassificationPreviewItem[] => {
  const target = getEntityById(classificationTargetId);
  const selectedNodes = getSelectedClassificationNodes();
  const existingKeys = existingRelationKeySet();

  return selectedNodes.map((source) => {
    const base = {
      sourceId: source.id,
      sourceName: source.name,
      targetId: target?.id ?? '',
      targetName: target?.name ?? '',
      relationType: classificationRelationType,
    };

    if (!target) {
      return { ...base, status: 'skip-missing', reason: '分類先conceptが未選択です。' };
    }
    if (source.id === target.id) {
      return { ...base, status: 'skip-self', reason: '同じノード同士のrelationは作成しません。' };
    }
    if (existingKeys.has(relationKey(source.id, target.id, classificationRelationType))) {
      return { ...base, status: 'skip-existing', reason: '同じrelationが既に存在します。' };
    }
    return { ...base, status: 'create', reason: 'relationを追加します。' };
  });
};

const getClassificationPreviewCounts = () =>
  getClassificationPreview().reduce(
    (counts, item) => {
      counts[item.status] += 1;
      return counts;
    },
    {
      create: 0,
      'skip-existing': 0,
      'skip-self': 0,
      'skip-missing': 0,
    } satisfies Record<ClassificationPreviewStatus, number>,
  );

const relationBaseDistance = (relationType: string) => {
  if (relationType === 'same_principle_as') return 46;
  if (relationType === 'similar_to') return 58;
  if (relationType === 'applies_to_technology') return 76;
  if (relationType.includes('_technology')) return 82;
  if (relationType.startsWith('captured_')) return 92;
  if (relationType === 'contains_guidance') return 170;
  return 120;
};

const relationDistance = (link: GraphLink) =>
  clamp(relationBaseDistance(link.relationType) / Math.sqrt(normalizedWeight(link)), 38, 220);

const relationStrength = (link: GraphLink) => {
  const base =
    link.relationType === 'same_principle_as'
      ? 0.95
      : link.relationType === 'similar_to'
        ? 0.78
        : link.relationType === 'applies_to_technology'
          ? 0.58
          : link.relationType.includes('_technology')
            ? 0.5
            : link.relationType.startsWith('captured_')
              ? 0.42
              : link.relationType === 'contains_guidance'
                ? 0.12
                : 0.28;
  return clamp(base * Math.sqrt(normalizedWeight(link)), 0.05, 1);
};

const relationColor = (relationType: string) => {
  if (relationType === 'same_principle_as') return '#22c55e';
  if (relationType === 'similar_to') return '#38bdf8';
  if (relationType === 'applies_to_technology') return '#f59e0b';
  if (relationType.includes('_technology')) return '#fbbf24';
  if (relationType.startsWith('captured_')) return '#a78bfa';
  if (relationType === 'contains_guidance') return '#475569';
  return '#94a3b8';
};

const relationOpacity = (relationType: string) => {
  if (relationType === 'contains_guidance') return 0.22;
  if (relationType === 'applies_to_technology') return 0.64;
  if (relationType.includes('_technology')) return 0.58;
  if (relationType === 'similar_to' || relationType === 'same_principle_as') return 0.72;
  return 0.42;
};

const toEditForm = (entity: Entity) => ({
  name: entity.name,
  type: entity.type,
  description: entity.description || '',
  confidence: entity.confidence ?? 0.5,
  scope: entity.scope || 'on_demand',
});

const closeNodeModal = () => {
  selectedNodeId = null;
  showDeleteConfirm = false;
};

const graphNodeStroke = (node: Pick<Entity, 'id'>) => {
  if (classificationMode && selectedClassificationIds.includes(node.id)) return '#facc15';
  if (!classificationMode && node.id === selectedNodeId) return '#fff';
  return 'rgba(255,255,255,0.2)';
};

const graphNodeStrokeWidth = (node: Pick<Entity, 'id'>) => {
  if (classificationMode && selectedClassificationIds.includes(node.id)) return 4;
  if (!classificationMode && node.id === selectedNodeId) return 3;
  return 1;
};

const updateGraphNodeStyles = () => {
  if (!svgContainer) return;
  d3.select(svgContainer)
    .selectAll<SVGCircleElement, GraphNode>('circle.graph-node')
    .attr('stroke', (node) => graphNodeStroke(node))
    .attr('stroke-width', (node) => graphNodeStrokeWidth(node));
};

const resetClassificationFeedback = () => {
  classificationError = null;
  classificationResult = null;
  classificationRelationsChecked = false;
  classificationRelationKeys = [];
};

const setClassificationMode = (enabled: boolean) => {
  classificationMode = enabled;
  selectedNodeId = null;
  formError = null;
  resetClassificationFeedback();
  if (!enabled) {
    selectedClassificationIds = [];
    classificationTargetId = '';
  }
  updateGraphNodeStyles();
};

const selectClassificationTarget = (targetId: string) => {
  classificationTargetId = targetId;
  const target = getEntityById(targetId);
  classificationRelationType = isTechnologyConcept(target)
    ? 'applies_to_technology'
    : 'belongs_to_concept';
  resetClassificationFeedback();
};

const setClassificationWeight = (value: string) => {
  classificationWeight = clamp(Number(value) || 1, 0.1, 3);
  resetClassificationFeedback();
};

const toggleClassificationNode = (id: string) => {
  resetClassificationFeedback();
  selectedClassificationIds = selectedClassificationIds.includes(id)
    ? selectedClassificationIds.filter((selectedId) => selectedId !== id)
    : [...selectedClassificationIds, id];
};

const removeClassificationNode = (id: string) => {
  resetClassificationFeedback();
  selectedClassificationIds = selectedClassificationIds.filter((selectedId) => selectedId !== id);
  updateGraphNodeStyles();
};

const clearClassificationSelection = () => {
  resetClassificationFeedback();
  selectedClassificationIds = [];
  updateGraphNodeStyles();
};

const refreshRelationIndex = async () => {
  const relations = await invoke<Relation[]>('monitor_list_relations');
  classificationRelationKeys = relations.map((relation) =>
    relationKey(relation.sourceId, relation.targetId, relation.relationType),
  );
  classificationRelationsChecked = true;
};

const handlePrepareClassification = async () => {
  classificationLoading = true;
  classificationError = null;
  classificationResult = null;
  try {
    await refreshRelationIndex();
  } catch (err) {
    classificationError = `Relation確認に失敗しました: ${
      err instanceof Error ? err.message : String(err)
    }`;
  } finally {
    classificationLoading = false;
  }
};

const handleApplyClassification = async () => {
  classificationLoading = true;
  classificationError = null;
  classificationResult = null;
  try {
    await refreshRelationIndex();
    const preview = getClassificationPreview();
    const candidates = preview.filter((item) => item.status === 'create');
    const failed: ClassificationResult['failed'] = [];
    let created = 0;

    for (const item of candidates) {
      try {
        await invoke('monitor_create_relation', {
          payload: JSON.stringify({
            sourceId: item.sourceId,
            targetId: item.targetId,
            relationType: item.relationType,
            weight: clamp(Number(classificationWeight) || 1, 0.1, 3),
          }),
        });
        created += 1;
      } catch (err) {
        failed.push({
          item,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    classificationResult = {
      created,
      skipped: preview.length - candidates.length,
      failed,
    };
    await loadGraph();
    await refreshRelationIndex();
  } catch (err) {
    classificationError = `分類の適用に失敗しました: ${
      err instanceof Error ? err.message : String(err)
    }`;
  } finally {
    classificationLoading = false;
  }
};

const onBackdropKeydown = (event: KeyboardEvent, callback: () => void) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    callback();
  }
  if (event.key === 'Escape') {
    callback();
  }
};

const loadGraph = async () => {
  loading = true;
  error = null;
  try {
    const data = await invoke<GraphSnapshot>('monitor_graph_snapshot');
    graphData = data;
    if (selectedNodeId && !data.entities.some((entity) => entity.id === selectedNodeId)) {
      selectedNodeId = null;
    }
    selectedClassificationIds = selectedClassificationIds.filter((selectedId) =>
      data.entities.some((entity) => entity.id === selectedId),
    );
    if (
      classificationTargetId &&
      !data.entities.some((entity) => entity.id === classificationTargetId)
    ) {
      classificationTargetId = '';
    }
    renderGraph(data);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
  }
};

const handleSave = async () => {
  if (!selectedNodeId) return;
  const id = selectedNodeId;
  formLoading = true;
  formError = null;
  try {
    await invoke('monitor_update_entity', {
      id,
      payload: JSON.stringify(editForm),
    });
    selectedNodeId = null;
    await loadGraph();
  } catch (err) {
    formError = `Update failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    formLoading = false;
  }
};

const handleDelete = () => {
  showDeleteConfirm = true;
};

const cancelDelete = () => {
  showDeleteConfirm = false;
};

const confirmDelete = async () => {
  if (!selectedNodeId) return;
  const id = selectedNodeId;
  formLoading = true;
  formError = null;
  try {
    await invoke('monitor_delete_entity', { id });
    selectedNodeId = null;
    showDeleteConfirm = false;
    await loadGraph();
  } catch (err) {
    formError = `Delete failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    formLoading = false;
  }
};

const renderGraph = (data: GraphSnapshot) => {
  if (!svgContainer) return;

  const width = svgContainer.clientWidth || 800;
  const height = svgContainer.clientHeight || 600;

  d3.select(svgContainer).selectAll('*').remove();

  if (data.entities.length === 0) return;

  const svg = d3.select(svgContainer);
  const mainContainer = svg.append('g');

  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => {
      mainContainer.attr('transform', event.transform);
    });

  svg.call(zoom);

  const nodes: GraphNode[] = data.entities.map((e) => ({ ...e }));
  const links: GraphLink[] = data.relations.map((r) => ({
    ...r,
    source: r.sourceId,
    target: r.targetId,
  }));

  const simulation = d3
    .forceSimulation<GraphNode>(nodes)
    .force(
      'link',
      d3
        .forceLink<GraphNode, GraphLink>(links)
        .id((d) => d.id)
        .distance((d) => relationDistance(d))
        .strength((d) => relationStrength(d)),
    )
    .force('charge', d3.forceManyBody<GraphNode>().strength(-360))
    .force('center', d3.forceCenter<GraphNode>(width / 2, height / 2))
    .force('collision', d3.forceCollide<GraphNode>().radius(40));

  const link = mainContainer
    .append('g')
    .selectAll('line')
    .data(links)
    .enter()
    .append('line')
    .attr('stroke', (d) => relationColor(d.relationType))
    .attr('stroke-opacity', (d) => relationOpacity(d.relationType))
    .attr('stroke-width', (d) => Math.sqrt(d.weight) + 1);

  const node = mainContainer
    .append('g')
    .selectAll('circle')
    .data(nodes)
    .enter()
    .append('circle')
    .attr('class', 'graph-node')
    .attr('r', (d) => 6 + Math.log(d.referenceCount + 1) * 3)
    .attr('fill', (d) => {
      if (d.type === 'concept') return '#f59e0b';
      if (d.type === 'goal') return '#ef4444';
      if (d.type === 'task') return '#3b82f6';
      if (d.type === 'constraint') return '#10b981';
      return '#64748b';
    })
    .attr('stroke', (d) => graphNodeStroke(d))
    .attr('stroke-width', (d) => graphNodeStrokeWidth(d))
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      event.stopPropagation();
      if (classificationMode) {
        toggleClassificationNode(d.id);
        updateGraphNodeStyles();
        return;
      }
      selectedNodeId = d.id;
      formError = null;
      editForm = toEditForm(d);
      updateGraphNodeStyles();
    })
    .call(
      d3
        .drag<SVGCircleElement, GraphNode>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }),
    );

  const label = mainContainer
    .append('g')
    .selectAll('text')
    .data(nodes)
    .enter()
    .append('text')
    .text((d) => truncateNodeLabel(d.name))
    .attr('font-size', 9)
    .attr('dx', 12)
    .attr('dy', 3)
    .attr('fill', '#e2e8f0')
    .style('pointer-events', 'none')
    .style('font-weight', '500')
    .style('text-shadow', '0 1px 2px rgba(0,0,0,0.5)');

  label.append('title').text((d) => d.name);

  simulation.on('tick', () => {
    link
      .attr('x1', (d) => (d.source as GraphNode).x || 0)
      .attr('y1', (d) => (d.source as GraphNode).y || 0)
      .attr('x2', (d) => (d.target as GraphNode).x || 0)
      .attr('y2', (d) => (d.target as GraphNode).y || 0);

    node.attr('cx', (d) => d.x || 0).attr('cy', (d) => d.y || 0);
    label.attr('x', (d) => d.x || 0).attr('y', (d) => d.y || 0);
  });
};

onMount(() => {
  void loadGraph();
});
</script>

<div class="container">
  <div class="graph-area">
    <div class="graph-header">
      <div class="title-group">
        <h2>Knowledge Graph</h2>
        <p>Interactive visualization of gnosis memories and relationships.</p>
      </div>
      <div class="actions">
        <button
          type="button"
          class:active={classificationMode}
          class="btn-mode"
          aria-pressed={classificationMode}
          onclick={() => setClassificationMode(!classificationMode)}
        >
          {classificationMode ? '分類モード中' : '分類モード'}
        </button>
        <button type="button" class="btn-reload" onclick={() => void loadGraph()} disabled={loading}>
          {#if loading}<span class="spin">↻</span>{:else}Reload Graph{/if}
        </button>
      </div>
    </div>

    {#if error}
      <div class="error-box">{error}</div>
    {/if}

    <div class="canvas-wrapper">
      <svg bind:this={svgContainer} class="graph-svg"></svg>
      {#if graphData}
        <div class="stats-overlay">
          <span class="stat"><b>{graphData.stats.totalEntitiesInDb}</b> Entities</span>
          <span class="divider"></span>
          <span class="stat"><b>{graphData.stats.totalRelationsInDb}</b> Relations</span>
        </div>
      {/if}
      {#if classificationMode}
        <aside class="classification-panel" aria-label="Graph classification panel">
          <div class="panel-heading">
            <div>
              <h3>Concept分類</h3>
              <p>{selectedClassificationIds.length} nodes selected</p>
            </div>
            <button type="button" class="ghost" onclick={clearClassificationSelection} disabled={classificationLoading}>
              Clear
            </button>
          </div>

          <label for="classification-target">
            分類先concept
            <select
              id="classification-target"
              value={classificationTargetId}
              onchange={(event) => selectClassificationTarget((event.currentTarget as HTMLSelectElement).value)}
            >
              <option value="">Select concept</option>
              {#each getConceptNodes() as concept (concept.id)}
                <option value={concept.id}>{concept.name}</option>
              {/each}
            </select>
          </label>

          <div class="control-row">
            <label for="classification-relation">
              Relation
              <select
                id="classification-relation"
                bind:value={classificationRelationType}
                onchange={resetClassificationFeedback}
              >
                <option value="applies_to_technology">applies_to_technology</option>
                <option value="belongs_to_concept">belongs_to_concept</option>
                <option value="related_to">related_to</option>
              </select>
            </label>
            <label for="classification-weight">
              Weight
              <input
                id="classification-weight"
                type="number"
                min="0.1"
                max="3"
                step="0.1"
                value={classificationWeight}
                oninput={(event) => setClassificationWeight((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
          </div>

          {#if selectedClassificationIds.length > 0}
            <div class="selected-list">
              {#each getSelectedClassificationNodes() as entity (entity.id)}
                <button
                  type="button"
                  class="selected-item"
                  title={entity.name}
                  onclick={() => removeClassificationNode(entity.id)}
                  disabled={classificationLoading}
                >
                  <span>{truncateNodeLabel(entity.name, 26)}</span>
                  <span class="remove-mark">×</span>
                </button>
              {/each}
            </div>
          {:else}
            <p class="empty-note">Graph上のノードをクリックして分類対象を選択します。</p>
          {/if}

          <div class="preview-summary">
            <span class="create">Add {getClassificationPreviewCounts().create}</span>
            <span>Existing {getClassificationPreviewCounts()['skip-existing']}</span>
            <span>
              Skipped {getClassificationPreviewCounts()['skip-self'] +
                getClassificationPreviewCounts()['skip-missing']}
            </span>
          </div>

          <div class="preview-list">
            {#each getClassificationPreview() as item (`${item.sourceId}-${item.targetId}-${item.relationType}`)}
              <div class:will-create={item.status === 'create'} class="preview-item">
                <span>{truncateNodeLabel(item.sourceName, 28)}</span>
                <small>{item.reason}</small>
              </div>
            {/each}
          </div>

          {#if classificationRelationsChecked}
            <p class="check-note">既存relation確認済みです。</p>
          {:else}
            <p class="check-note warning">適用前に既存relationを確認してください。</p>
          {/if}

          {#if classificationError}<p class="error-text">{classificationError}</p>{/if}
          {#if classificationResult}
            <p class="result-text">
              Created {classificationResult.created}, skipped {classificationResult.skipped}, failed {classificationResult.failed.length}
            </p>
          {/if}

          <div class="panel-actions">
            <button type="button" onclick={handlePrepareClassification} disabled={classificationLoading}>
              {classificationLoading ? 'Checking...' : '重複確認'}
            </button>
            <button
              type="button"
              class="primary"
              onclick={handleApplyClassification}
              disabled={classificationLoading || !classificationRelationsChecked || getClassificationPreviewCounts().create === 0}
            >
              {classificationLoading ? 'Applying...' : '分類を適用'}
            </button>
          </div>
        </aside>
      {/if}
    </div>
  </div>

</div>

{#if selectedNode}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    onclick={closeNodeModal}
    onkeydown={(event) => onBackdropKeydown(event, closeNodeModal)}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      <h2>Knowledge 編集</h2>
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
      >
        <label for="node-name">
          Display Name
          <input id="node-name" type="text" bind:value={editForm.name} disabled />
          <span class="field-note">ID整合性のため、名称変更は再作成で扱います。</span>
        </label>
        <label for="node-type">
          Knowledge Type
          <select id="node-type" bind:value={editForm.type} disabled>
            <option value="goal">goal</option>
            <option value="task">task</option>
            <option value="constraint">constraint</option>
            <option value="concept">concept</option>
            <option value="rule">rule</option>
            <option value="procedure">procedure</option>
            <option value="lesson">lesson</option>
            <option value="decision">decision</option>
            <option value="project_doc">project_doc</option>
          </select>
          <span class="field-note">タイプ変更も既存IDと衝突するため無効化しています。</span>
        </label>
        <label for="node-scope">
          Execution Scope
          <select id="node-scope" bind:value={editForm.scope}>
            <option value="on_demand">on_demand</option>
            <option value="always">always</option>
          </select>
        </label>
        <label for="node-conf">
          System Confidence ({(editForm.confidence * 100).toFixed(0)}%)
          <input id="node-conf" type="range" min="0" max="1" step="0.01" bind:value={editForm.confidence} />
        </label>
        <label for="node-desc">
          Full Description
          <textarea id="node-desc" bind:value={editForm.description} rows="8" placeholder="Describe this piece of knowledge..."></textarea>
        </label>
        {#if formError}<p class="error-text">{formError}</p>{/if}
        <div class="form-actions split">
          {#if !showDeleteConfirm}
            <button type="button" class="danger" onclick={handleDelete} disabled={formLoading}>
              {formLoading ? '処理中...' : '削除'}
            </button>
            <div class="right-actions">
              <button type="button" onclick={closeNodeModal} disabled={formLoading}>キャンセル</button>
              <button type="submit" disabled={formLoading}>{formLoading ? '保存中...' : '保存'}</button>
            </div>
          {:else}
            <div class="confirm-box">
              <span class="warning-text">本当に削除しますか？</span>
              <div class="confirm-actions">
                <button type="button" class="danger small" onclick={confirmDelete} disabled={formLoading}>はい</button>
                <button type="button" class="ghost small" onclick={cancelDelete} disabled={formLoading}>いいえ</button>
              </div>
            </div>
          {/if}
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .container {
    display: flex;
    height: 100%;
    background: #020617;
    color: #f1f5f9;
  }

  .graph-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 32px;
    position: relative;
    background: radial-gradient(circle at 50% 50%, rgba(30, 58, 138, 0.05) 0%, transparent 100%);
  }

  .graph-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 24px;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  
  .title-group h2 { font-size: 1.5rem; font-weight: 800; color: #f8fafc; }
  .title-group p { font-size: 0.875rem; color: #64748b; margin-top: 4px; }

  .canvas-wrapper {
    flex: 1;
    position: relative;
    background: rgba(15, 23, 42, 0.4);
    border-radius: 20px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    overflow: hidden;
    backdrop-filter: blur(8px);
  }

  .graph-svg { width: 100%; height: 100%; }

  .stats-overlay {
    position: absolute;
    bottom: 20px;
    right: 20px;
    background: rgba(15, 23, 42, 0.8);
    padding: 10px 20px;
    border-radius: 12px;
    font-size: 0.8rem;
    color: #94a3b8;
    border: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .divider { width: 1px; height: 12px; background: rgba(255, 255, 255, 0.2); }
  .stats-overlay b { color: #f1f5f9; }

  .classification-panel {
    position: absolute;
    top: 16px;
    right: 16px;
    width: min(360px, calc(100% - 32px));
    max-height: calc(100% - 32px);
    overflow: auto;
    display: grid;
    gap: 0.8rem;
    padding: 1rem;
    background: rgba(2, 6, 23, 0.92);
    border: 1px solid rgba(148, 163, 184, 0.24);
    border-radius: 8px;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.28);
  }

  .panel-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .panel-heading h3 {
    margin: 0;
    font-size: 1rem;
    color: #f8fafc;
  }

  .panel-heading p,
  .empty-note,
  .check-note {
    margin: 0.2rem 0 0;
    color: #94a3b8;
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .check-note.warning {
    color: #fbbf24;
  }

  .control-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 96px;
    gap: 0.65rem;
  }

  .selected-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    max-height: 120px;
    overflow: auto;
  }

  .selected-item {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    max-width: 100%;
    padding: 0.3rem 0.45rem;
    border-color: rgba(250, 204, 21, 0.42);
    background: rgba(250, 204, 21, 0.1);
    color: #f8fafc;
  }

  .selected-item span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .remove-mark {
    color: #facc15;
    font-weight: 700;
  }

  .preview-summary {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.4rem;
  }

  .preview-summary span {
    padding: 0.4rem;
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 6px;
    text-align: center;
    color: #cbd5e1;
    font-size: 0.76rem;
    background: rgba(15, 23, 42, 0.72);
  }

  .preview-summary .create {
    color: #bbf7d0;
    border-color: rgba(34, 197, 94, 0.26);
  }

  .preview-list {
    display: grid;
    gap: 0.35rem;
    max-height: 160px;
    overflow: auto;
  }

  .preview-item {
    display: grid;
    gap: 0.15rem;
    padding: 0.45rem;
    border-radius: 6px;
    background: rgba(15, 23, 42, 0.74);
    border: 1px solid rgba(148, 163, 184, 0.14);
  }

  .preview-item.will-create {
    border-color: rgba(34, 197, 94, 0.28);
  }

  .preview-item span {
    color: #e2e8f0;
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-item small {
    color: #94a3b8;
    font-size: 0.72rem;
  }

  .panel-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 23, 0.72);
    display: grid;
    place-items: center;
    z-index: 1000;
  }

  .modal {
    width: min(760px, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    overflow: auto;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 10px;
    padding: 1rem;
    display: grid;
    gap: 0.75rem;
    color: #e5e7eb;
  }

  .modal h2 {
    margin: 0;
    font-size: 1.2rem;
    color: #f8fafc;
  }

  form {
    display: grid;
    gap: 0.75rem;
  }

  label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.92rem;
    color: #cbd5e1;
  }

  .field-note {
    margin: 0;
    font-size: 0.75rem;
    color: #94a3b8;
    line-height: 1.4;
  }

  input, select, textarea {
    padding: 0.5rem;
    border: 1px solid #475467;
    border-radius: 6px;
    font: inherit;
    background: #020617;
    color: #e5e7eb;
    outline: none;
  }

  input:focus, select:focus, textarea:focus { border-color: #3b82f6; }
  input:disabled, select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-reload {
    padding: 10px 20px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #f1f5f9;
    border-radius: 10px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn-reload:hover { background: rgba(255, 255, 255, 0.1); }

  .btn-mode {
    padding: 10px 16px;
    background: rgba(250, 204, 21, 0.1);
    border: 1px solid rgba(250, 204, 21, 0.25);
    color: #fde68a;
    border-radius: 10px;
    font-weight: 600;
  }

  .btn-mode.active {
    background: rgba(250, 204, 21, 0.22);
    border-color: rgba(250, 204, 21, 0.58);
    color: #fef3c7;
  }

  .spin { display: inline-block; animation: spin 1s linear infinite; }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.5rem;
  }

  .form-actions.split {
    justify-content: space-between;
  }

  .right-actions {
    display: flex;
    gap: 0.5rem;
  }

  button {
    background: #1f2937;
    color: #f9fafb;
    border: 1px solid #4b5563;
    border-radius: 8px;
    padding: 0.45rem 0.75rem;
    cursor: pointer;
  }

  button:hover { background: #374151; }
  button:disabled { opacity: 0.55; cursor: not-allowed; }

  button.primary {
    background: #2563eb;
    border-color: #3b82f6;
  }

  button.primary:hover { background: #1d4ed8; }

  button.ghost {
    background: rgba(15, 23, 42, 0.2);
    border-color: rgba(148, 163, 184, 0.3);
    color: #cbd5e1;
  }

  button.danger {
    color: #fda4af;
    border-color: #7f1d1d;
    background: #2b1114;
  }

  button.danger:hover { background: #3b141a; }

  .error-text { color: #fca5a5; margin: 0; }

  .confirm-box {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 12px;
    background: rgba(127, 29, 29, 0.2);
    border: 1px solid rgba(127, 29, 29, 0.4);
    border-radius: 8px;
    gap: 12px;
  }

  .warning-text {
    font-size: 0.85rem;
    color: #fda4af;
    font-weight: 500;
  }

  .confirm-actions {
    display: flex;
    gap: 0.5rem;
  }

  button.small {
    padding: 0.3rem 0.6rem;
    font-size: 0.8rem;
  }

  .result-text {
    color: #bbf7d0;
    margin: 0;
    font-size: 0.8rem;
  }

  .error-box { background: rgba(239, 68, 68, 0.1); color: #ef4444; padding: 12px 20px; border-radius: 10px; border: 1px solid rgba(239, 68, 68, 0.2); margin-bottom: 20px; }

  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
