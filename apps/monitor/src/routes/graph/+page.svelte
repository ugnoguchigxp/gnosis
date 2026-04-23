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
let editForm = $state({
  name: '',
  type: '',
  description: '',
  confidence: 0.5,
  scope: 'on_demand',
});

const toEditForm = (entity: Entity) => ({
  name: entity.name,
  type: entity.type,
  description: entity.description || '',
  confidence: entity.confidence ?? 0.5,
  scope: entity.scope || 'on_demand',
});

const loadGraph = async () => {
  loading = true;
  error = null;
  try {
    const data = await invoke<GraphSnapshot>('monitor_graph_snapshot');
    graphData = data;
    if (selectedNodeId && !data.entities.some((entity) => entity.id === selectedNodeId)) {
      selectedNodeId = null;
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
  try {
    await invoke('monitor_update_entity', {
      id: selectedNodeId,
      payload: JSON.stringify(editForm),
    });
    await loadGraph();
    alert('Entity updated successfully');
  } catch (err) {
    alert(`Update failed: ${err}`);
  }
};

const handleDelete = async () => {
  if (!selectedNodeId || !confirm('Are you sure you want to delete this entity?')) return;
  try {
    await invoke('monitor_delete_entity', { id: selectedNodeId });
    selectedNodeId = null;
    await loadGraph();
  } catch (err) {
    alert(`Delete failed: ${err}`);
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
        .distance(100),
    )
    .force('charge', d3.forceManyBody<GraphNode>().strength(-400))
    .force('center', d3.forceCenter<GraphNode>(width / 2, height / 2))
    .force('collision', d3.forceCollide<GraphNode>().radius(40));

  const link = mainContainer
    .append('g')
    .selectAll('line')
    .data(links)
    .enter()
    .append('line')
    .attr('stroke', '#475569')
    .attr('stroke-opacity', 0.4)
    .attr('stroke-width', (d) => Math.sqrt(d.weight) + 1);

  const node = mainContainer
    .append('g')
    .selectAll('circle')
    .data(nodes)
    .enter()
    .append('circle')
    .attr('r', (d) => 6 + Math.log(d.referenceCount + 1) * 3)
    .attr('fill', (d) => {
      if (d.type === 'goal') return '#ef4444';
      if (d.type === 'task') return '#3b82f6';
      if (d.type === 'constraint') return '#10b981';
      return '#64748b';
    })
    .attr('stroke', (d) => (d.id === selectedNodeId ? '#fff' : 'rgba(255,255,255,0.2)'))
    .attr('stroke-width', (d) => (d.id === selectedNodeId ? 3 : 1))
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      selectedNodeId = d.id;
      editForm = toEditForm(d);
      node
        .attr('stroke', (n) => (n.id === d.id ? '#fff' : 'rgba(255,255,255,0.2)'))
        .attr('stroke-width', (n) => (n.id === d.id ? 3 : 1));
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
    .text((d) => d.name)
    .attr('font-size', 11)
    .attr('dx', 14)
    .attr('dy', 4)
    .attr('fill', '#e2e8f0')
    .style('pointer-events', 'none')
    .style('font-weight', '500')
    .style('text-shadow', '0 1px 2px rgba(0,0,0,0.5)');

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
    </div>
  </div>

  <aside class="side-panel" class:open={selectedNodeId}>
    {#if selectedNode}
      <div class="panel-header">
        <h3>Edit Knowledge</h3>
        <button class="close-icon" onclick={() => selectedNodeId = null}>&times;</button>
      </div>
      
      <div class="form">
        <div class="field">
          <label for="node-name">Display Name</label>
          <input id="node-name" type="text" bind:value={editForm.name} disabled />
          <p class="field-note">ID整合性のため、名称変更は再作成で扱います。</p>
        </div>
        <div class="field">
          <label for="node-type">Knowledge Type</label>
          <select id="node-type" bind:value={editForm.type} disabled>
            <option value="goal">Goal (Objective)</option>
            <option value="task">Task (Action)</option>
            <option value="constraint">Constraint</option>
            <option value="concept">Concept</option>
          </select>
          <p class="field-note">タイプ変更も既存IDと衝突するため無効化しています。</p>
        </div>
        <div class="field">
          <label for="node-scope">Execution Scope</label>
          <select id="node-scope" bind:value={editForm.scope}>
            <option value="on_demand">On Demand</option>
            <option value="always">Always Active</option>
          </select>
        </div>
        <div class="field">
          <label for="node-conf">System Confidence ({(editForm.confidence * 100).toFixed(0)}%)</label>
          <input id="node-conf" type="range" min="0" max="1" step="0.01" bind:value={editForm.confidence} />
        </div>
        <div class="field">
          <label for="node-desc">Full Description</label>
          <textarea id="node-desc" bind:value={editForm.description} rows="6" placeholder="Describe this piece of knowledge..."></textarea>
        </div>
        
        <div class="panel-actions">
          <button type="button" class="btn save" onclick={handleSave}>Sync to Graph</button>
          <div class="row">
            <button type="button" class="btn delete" onclick={handleDelete}>Delete Node</button>
            <button type="button" class="btn cancel" onclick={() => selectedNodeId = null}>Close</button>
          </div>
        </div>
      </div>
    {:else}
      <div class="empty-state">
        <div class="icon">🔍</div>
        <p>Select a node to inspect and modify its properties.</p>
      </div>
    {/if}
  </aside>
</div>

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

  .side-panel {
    width: 0;
    background: rgba(15, 23, 42, 0.6);
    border-left: 1px solid rgba(255, 255, 255, 0.05);
    transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    backdrop-filter: blur(20px);
  }

  .side-panel.open { width: 400px; padding: 32px; }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
  }
  .panel-header h3 { font-size: 1.25rem; font-weight: 700; color: #f8fafc; }
  .close-icon { background: none; border: none; color: #64748b; font-size: 1.5rem; cursor: pointer; }

  .form { display: flex; flex-direction: column; gap: 20px; }
  .field { display: flex; flex-direction: column; gap: 8px; }
  .field label { font-size: 0.75rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .field-note { margin: 0; font-size: 0.75rem; color: #94a3b8; line-height: 1.4; }

  input, select, textarea {
    background: rgba(15, 23, 42, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: white;
    padding: 12px;
    border-radius: 10px;
    font-size: 0.9rem;
    outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: #3b82f6; }
  input:disabled, select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .panel-actions { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
  .panel-actions .row { display: flex; gap: 12px; }

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
  .spin { display: inline-block; animation: spin 1s linear infinite; }

  .btn { padding: 12px; border-radius: 10px; font-weight: 700; cursor: pointer; border: none; flex: 1; transition: all 0.2s; }
  .btn.save { background: #3b82f6; color: white; }
  .btn.delete { background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); }
  .btn.cancel { background: rgba(255, 255, 255, 0.05); color: #94a3b8; }
  .btn:hover { filter: brightness(1.1); transform: translateY(-1px); }

  .empty-state {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #64748b;
    text-align: center;
    gap: 16px;
  }
  .empty-state .icon { font-size: 3rem; }

  .error-box { background: rgba(239, 68, 68, 0.1); color: #ef4444; padding: 12px 20px; border-radius: 10px; border: 1px solid rgba(239, 68, 68, 0.2); margin-bottom: 20px; }

  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
