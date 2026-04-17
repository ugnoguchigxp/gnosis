<script lang="ts">
import { invoke } from '@tauri-apps/api/core';
import * as d3 from 'd3';
import { onMount } from 'svelte';

type GraphNode = d3.SimulationNodeDatum & {
  id: string;
  name: string;
  type: string;
  description: string | null;
  communityId: string | null;
  referenceCount: number;
};

type GraphLink = d3.SimulationLinkDatum<GraphNode> & {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  relationType: string;
  weight: number;
};

type GraphSnapshot = {
  entities: Array<{
    id: string;
    name: string;
    type: string;
    description: string | null;
    communityId: string | null;
    referenceCount: number;
  }>;
  relations: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    relationType: string;
    weight: number;
  }>;
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

const COLORS = d3.schemeCategory10;

const loadGraph = async () => {
  loading = true;
  error = null;
  try {
    const data = await invoke<GraphSnapshot>('monitor_graph_snapshot');
    graphData = data;
    renderGraph(data);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
  }
};

const renderGraph = (data: GraphSnapshot) => {
  if (!svgContainer || data.entities.length === 0) return;

  const width = svgContainer.clientWidth || 800;
  const height = svgContainer.clientHeight || 600;

  d3.select(svgContainer).selectAll('*').remove();

  const svg = d3.select(svgContainer);

  // ズーム・パン挙動の定義
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => {
      mainContainer.attr('transform', event.transform);
    });

  // すべての要素を収めるメインコンテナ
  const mainContainer = svg.append('g');

  // svg にズーム機能を適用
  svg.call(zoom);

  const nodes: GraphNode[] = data.entities.map((e) => ({ ...e }));
  const links: GraphLink[] = data.relations.map((r) => ({
    id: r.id,
    source: r.sourceId,
    target: r.targetId,
    relationType: r.relationType,
    weight: r.weight,
  }));

  const simulation = d3
    .forceSimulation<GraphNode>(nodes)
    .force(
      'link',
      d3
        .forceLink<GraphNode, GraphLink>(links)
        .id((d) => d.id)
        .distance(100), // 少し余裕を持たせる
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
    .attr('stroke', '#94a3b8')
    .attr('stroke-opacity', 0.6)
    .attr('stroke-width', (d) => Math.sqrt(d.weight) + 1);

  const node = mainContainer
    .append('g')
    .selectAll('circle')
    .data(nodes)
    .enter()
    .append('circle')
    .attr('r', (d) => 6 + Math.log(d.referenceCount + 1) * 3)
    .attr('fill', (d) => {
      if (d.communityId) {
        const hash = d.communityId
          .split('')
          .reduce((acc: number, c: string) => acc + c.charCodeAt(0), 0);
        return COLORS[hash % COLORS.length];
      }
      return '#3b82f6';
    })
    .attr('stroke', '#fff')
    .attr('stroke-width', 2)
    .style('cursor', 'grab')
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
    .attr('fill', '#1e293b')
    .style('pointer-events', 'none')
    .style('font-weight', '500');

  node.append('title').text((d) => `${d.name}\n${d.type}\n${d.description || ''}`);

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

<div class="graph-view">
  <div class="graph-header">
    <h2>Knowledge Graph</h2>
    <button type="button" onclick={() => void loadGraph()} disabled={loading}>
      {loading ? 'Loading...' : 'Reload'}
    </button>
  </div>

  {#if error}
    <div class="error-text">{error}</div>
  {/if}

  {#if graphData}
    <div class="graph-stats">
      <span>Entities: {graphData.stats.totalEntities} / {graphData.stats.totalEntitiesInDb}</span>
      <span>Relations: {graphData.stats.totalRelations} / {graphData.stats.totalRelationsInDb}</span>
      <span>Communities: {graphData.stats.totalCommunities} / {graphData.stats.totalCommunitiesInDb}</span>
      {#if graphData.stats.limitApplied}
        <span class="limit-warning">⚠️ Limit applied</span>
      {/if}
    </div>
  {/if}

  <svg bind:this={svgContainer} class="graph-svg"></svg>
</div>

<style>
  .graph-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 16px;
  }

  .graph-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .graph-header h2 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }

  .graph-stats {
    display: flex;
    gap: 16px;
    margin-bottom: 12px;
    font-size: 0.9rem;
    color: #475569;
    flex-wrap: wrap;
  }

  .limit-warning {
    color: #f59e0b;
    font-weight: 500;
  }

  .graph-svg {
    flex: 1;
    width: 100%;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    background: #f8fafc;
  }

  .error-text {
    color: #dc2626;
    padding: 8px 12px;
    background: #fee;
    border-radius: 4px;
    margin-bottom: 12px;
  }

  button {
    padding: 8px 16px;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.9rem;
  }

  button:hover:not(:disabled) {
    background: #2563eb;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
