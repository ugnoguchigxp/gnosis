<script lang="ts">
import type { Entity } from '$lib/monitor/types';
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';

type ProcedureDetail = {
  goal: Entity;
  steps: Array<{
    taskId: string;
    taskName: string;
    description: string;
    confidence: number;
  }>;
  flows: Array<{
    sourceId: string;
    targetId: string;
    relationType: string;
  }>;
};

let goals = $state<Entity[]>([]);
let allTasks = $state<Entity[]>([]);
let selectedGoalId = $state<string | null>(null);
let procedure = $state<ProcedureDetail | null>(null);
let loading = $state(false);
let error = $state<string | null>(null);

// biome-ignore lint/style/useConst: reassigned in template
let activeTab = $state<'search' | 'create'>('search');
let newTaskSearchQuery = $state('');
let customStepName = $state('');
let customStepDesc = $state('');

const sortedSteps = $derived.by(() => {
  if (!procedure) return [];
  const order = (procedure.goal.metadata as { stepsOrder?: string[] })?.stepsOrder || [];
  const steps = [...procedure.steps];

  if (order.length > 0) {
    steps.sort((a, b) => {
      const idxA = order.indexOf(a.taskId);
      const idxB = order.indexOf(b.taskId);
      if (idxA === -1 && idxB === -1) return 0;
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
  }
  return steps;
});

const filteredTasks = $derived.by(() => {
  if (!newTaskSearchQuery.trim()) return [];
  const query = newTaskSearchQuery.toLowerCase();
  return allTasks
    .filter(
      (t) =>
        (t.name.toLowerCase().includes(query) ||
          t.description?.toLowerCase().includes(query) ||
          '') &&
        !procedure?.steps.some((s) => s.taskId === t.id),
    )
    .slice(0, 5);
});

const loadGoals = async () => {
  try {
    goals = await invoke<Entity[]>('monitor_list_goals');
  } catch (err) {
    error = String(err);
  }
};

const loadAllTasks = async () => {
  try {
    const entities = await invoke<Entity[]>('monitor_list_entities');
    allTasks = entities.filter((e) => e.type === 'task');
  } catch (err) {
    console.error(err);
  }
};

const selectGoal = async (id: string) => {
  selectedGoalId = id;
  loading = true;
  procedure = null;
  error = null;
  newTaskSearchQuery = '';
  try {
    procedure = await invoke<ProcedureDetail>('monitor_get_procedure', { goalId: id });
  } catch (err) {
    error = `Failed to load procedure: ${err}`;
  } finally {
    loading = false;
  }
};

const moveStep = async (index: number, direction: 'up' | 'down') => {
  if (!procedure || !selectedGoalId) return;
  const steps = [...sortedSteps];
  const newIndex = direction === 'up' ? index - 1 : index + 1;
  if (newIndex < 0 || newIndex >= steps.length) return;

  [steps[index], steps[newIndex]] = [steps[newIndex], steps[index]];
  const newOrder = steps.map((s) => s.taskId);

  try {
    await invoke('monitor_reorder_steps', { goalId: selectedGoalId, stepsOrder: newOrder });
    if (procedure.goal.metadata) {
      (procedure.goal.metadata as { stepsOrder?: string[] }).stepsOrder = newOrder;
    } else {
      procedure.goal.metadata = { stepsOrder: newOrder };
    }
  } catch (err) {
    alert(`Failed to reorder: ${err}`);
  }
};

const handleCreateCustom = async () => {
  if (!selectedGoalId || !customStepName) return;
  try {
    await invoke('monitor_create_custom_step', {
      goalId: selectedGoalId,
      name: customStepName,
      description: customStepDesc,
    });
    customStepName = '';
    customStepDesc = '';
    await selectGoal(selectedGoalId);
    await loadAllTasks();
  } catch (err) {
    alert(`Failed to create custom step: ${err}`);
  }
};

const handleAddStep = async (taskId: string) => {
  if (!selectedGoalId) return;
  try {
    await invoke('monitor_add_step', { goalId: selectedGoalId, taskId });
    newTaskSearchQuery = '';
    await selectGoal(selectedGoalId);
  } catch (err) {
    alert(`Failed to add step: ${err}`);
  }
};

const handleRemoveStep = async (taskId: string) => {
  if (!selectedGoalId || !confirm(`Remove step?\nTask: ${taskId}`)) return;
  try {
    await invoke('monitor_remove_step', { goalId: selectedGoalId, taskId });
    await selectGoal(selectedGoalId);
  } catch (err) {
    alert(`Failed to remove step: ${err}`);
  }
};

const updateConfidence = async (taskId: string, confidence: number) => {
  try {
    await invoke('monitor_set_task_confidence', { taskId, confidence });
    if (procedure) {
      procedure.steps = procedure.steps.map((s) =>
        s.taskId === taskId ? { ...s, confidence } : s,
      );
    }
  } catch (err) {
    alert(`Failed to update confidence: ${err}`);
  }
};

onMount(() => {
  void loadGoals();
  void loadAllTasks();
});
</script>

<div class="procedure-page">
  <aside class="goal-list">
    <div class="section-label">OBJECTIVES</div>
    <div class="goals">
      {#each goals as goal}
        <button 
          class="goal-card" 
          class:active={selectedGoalId === goal.id}
          onclick={() => selectGoal(goal.id)}
        >
          <div class="goal-name">{goal.name}</div>
          <div class="goal-id">{goal.id}</div>
        </button>
      {/each}
    </div>
  </aside>

  <main class="procedure-content">
    {#if error}
      <div class="error-view">
        <div class="error-icon">⚠️</div>
        <h3>Analysis Failed</h3>
        <p>{error}</p>
        <button class="btn-retry" onclick={() => selectedGoalId && selectGoal(selectedGoalId)}>Retry Analysis</button>
      </div>
    {:else if loading}
      <div class="empty">
        <div class="spinner"></div>
        <p>Analyzing success procedures...</p>
      </div>
    {:else if procedure}
      <div class="header">
        <div class="header-main">
          <div class="badge">Knowledge Orchestration</div>
          <h2>{procedure.goal.name}</h2>
          <p>{procedure.goal.description || 'No description provided.'}</p>
        </div>
      </div>

      <div class="flow-view">
        <div class="section-header">
          <h3><span class="icon">⚡</span> Procedural Flow</h3>
          <span class="step-count">{procedure.steps.length} Steps Defined</span>
        </div>
        
        <div class="step-list">
          {#each sortedSteps as step, i}
            {@const dependencies = procedure.flows.filter(f => f.targetId === step.taskId)}
            <div class="step-card">
              <div class="step-nav">
                <button class="nav-btn" onclick={() => moveStep(i, 'up')} disabled={i === 0}>▲</button>
                <div class="step-number">{i + 1}</div>
                <button class="nav-btn" onclick={() => moveStep(i, 'down')} disabled={i === sortedSteps.length - 1}>▼</button>
              </div>
              <div class="step-main">
                <div class="step-name">{step.taskName}</div>
                <div class="step-desc">{step.description}</div>
                
                {#if dependencies.length > 0}
                  <div class="dependencies">
                    <span class="dep-label">Depends on:</span>
                    {#each dependencies as dep}
                      {@const depStep = procedure.steps.find(s => s.taskId === dep.sourceId)}
                      <span class="dep-tag">{depStep?.taskName || dep.sourceId}</span>
                    {/each}
                  </div>
                {/if}
              </div>
              <div class="step-actions">
                <div class="step-control">
                  <div class="control-label">
                    <span>Confidence</span>
                    <span class="conf-value">{(step.confidence * 100).toFixed(0)}%</span>
                  </div>
                  <input 
                    type="range" 
                    min="0" 
                    max="1" 
                    step="0.01" 
                    value={step.confidence}
                    onchange={(e) => updateConfidence(step.taskId, parseFloat(e.currentTarget.value))}
                  />
                </div>
                <button class="btn-remove" onclick={() => handleRemoveStep(step.taskId)} title="Remove step">
                  &times;
                </button>
              </div>
            </div>
          {/each}
        </div>

        <div class="add-step-section">
          <div class="tab-header">
            <button class:active={activeTab === 'search'} onclick={() => activeTab = 'search'}>Inject Knowledge</button>
            <button class:active={activeTab === 'create'} onclick={() => activeTab = 'create'}>Define Custom Step</button>
          </div>
          
          <div class="tab-content">
            {#if activeTab === 'search'}
              <div class="search-box">
                <input 
                  type="text" 
                  placeholder="Search for successful tasks in knowledge graph..." 
                  bind:value={newTaskSearchQuery}
                />
              </div>
              
              {#if filteredTasks.length > 0}
                <div class="search-results">
                  {#each filteredTasks as task}
                    <div class="result-item">
                      <div class="result-info">
                        <div class="result-name">{task.name}</div>
                        <div class="result-desc">{task.description?.slice(0, 80) || 'No description'}</div>
                      </div>
                      <button class="btn-add-result" onclick={() => handleAddStep(task.id)}>+</button>
                    </div>
                  {/each}
                </div>
              {:else if newTaskSearchQuery.trim()}
                <div class="no-results">No relevant knowledge found</div>
              {/if}
            {:else}
              <div class="create-form">
                <input type="text" placeholder="Step Name (e.g. Verify environment)" bind:value={customStepName} />
                <textarea placeholder="Detailed instructions for the AI agent..." bind:value={customStepDesc} rows="3"></textarea>
                <button class="btn-create" onclick={handleCreateCustom} disabled={!customStepName}>
                  Create & Append Step
                </button>
              </div>
            {/if}
          </div>
        </div>
      </div>
    {:else}
      <div class="empty">
        <div class="welcome-icon">🧠</div>
        <h3>Knowledge Orchestration</h3>
        <p>Select an objective to architect its validated execution path.</p>
      </div>
    {/if}
  </main>
</div>

<style>
  .procedure-page { display: flex; height: 100%; background: #020617; color: #f1f5f9; }

  .goal-list {
    width: 340px;
    background: rgba(15, 23, 42, 0.5);
    border-right: 1px solid rgba(255, 255, 255, 0.05);
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .section-label { font-size: 0.7rem; font-weight: 800; color: #64748b; letter-spacing: 0.1em; padding-left: 8px; }
  .goals { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }

  .goal-card {
    text-align: left; padding: 16px; border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 14px; background: rgba(255, 255, 255, 0.02); cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .goal-card:hover { background: rgba(255, 255, 255, 0.05); border-color: rgba(59, 130, 246, 0.3); transform: translateX(4px); }
  .goal-card.active { background: rgba(59, 130, 246, 0.1); border-color: #3b82f6; box-shadow: 0 0 20px rgba(59, 130, 246, 0.15); }

  .goal-name { font-weight: 600; font-size: 0.95rem; color: #f1f5f9; }
  .goal-id { font-size: 0.7rem; color: #64748b; margin-top: 8px; font-family: monospace; }

  .procedure-content { flex: 1; padding: 60px; overflow-y: auto; background: radial-gradient(circle at 50% 0%, rgba(30, 58, 138, 0.1) 0%, transparent 70%); }

  .header { margin-bottom: 48px; }
  .badge { display: inline-block; padding: 4px 12px; background: rgba(16, 185, 129, 0.1); color: #10b981; border-radius: 100px; font-size: 0.75rem; font-weight: 700; margin-bottom: 16px; border: 1px solid rgba(16, 185, 129, 0.2); }
  .header h2 { font-size: 2.25rem; font-weight: 800; color: #f8fafc; letter-spacing: -0.025em; }
  .header p { color: #94a3b8; margin-top: 12px; font-size: 1.1rem; line-height: 1.6; max-width: 800px; }

  .error-view { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 20px; }
  .error-icon { font-size: 3rem; }
  .error-view h3 { font-size: 1.5rem; color: #f1f5f9; }
  .error-view p { color: #ef4444; max-width: 500px; line-height: 1.6; background: rgba(239, 68, 68, 0.1); padding: 16px; border-radius: 12px; border: 1px solid rgba(239, 68, 68, 0.2); }
  .btn-retry { padding: 12px 24px; background: #3b82f6; color: white; border: none; border-radius: 10px; font-weight: 700; cursor: pointer; }

  .section-header { margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.05); padding-bottom: 12px; }
  .section-header h3 { font-size: 1rem; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 8px; }
  .step-count { font-size: 0.8rem; color: #64748b; font-weight: 600; }

  .step-list { display: flex; flex-direction: column; gap: 16px; margin-bottom: 48px; }

  .step-card {
    background: rgba(30, 41, 59, 0.4); padding: 24px; border-radius: 20px; border: 1px solid rgba(255, 255, 255, 0.05);
    display: flex; align-items: center; gap: 24px; backdrop-filter: blur(10px); transition: all 0.3s;
  }

  .step-nav { display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; }
  .nav-btn { background: none; border: none; color: #64748b; cursor: pointer; padding: 4px; font-size: 0.7rem; }
  .nav-btn:hover:not(:disabled) { color: #3b82f6; }
  .nav-btn:disabled { opacity: 0.2; cursor: default; }

  .step-number { width: 32px; height: 32px; background: #1e293b; border: 1px solid rgba(255, 255, 255, 0.1); color: #3b82f6; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 0.9rem; }

  .step-main { flex: 1; }
  .step-name { font-weight: 700; color: #f8fafc; font-size: 1.1rem; }
  .step-desc { font-size: 0.9rem; color: #94a3b8; margin-top: 6px; line-height: 1.5; }

  .dependencies { margin-top: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .dep-label { font-size: 0.7rem; font-weight: 700; color: #475569; text-transform: uppercase; }
  .dep-tag { 
    padding: 2px 10px; 
    background: rgba(34, 197, 94, 0.05); /* Very light green */
    color: #22c55e; /* Terminal Green */
    border: 1px solid rgba(34, 197, 94, 0.2); 
    border-radius: 6px; font-size: 0.75rem; font-weight: 600; 
  }

  .step-actions { display: flex; align-items: center; gap: 32px; }
  .step-control { width: 180px; }
  .control-label { display: flex; justify-content: space-between; font-size: 0.75rem; font-weight: 700; color: #64748b; margin-bottom: 10px; }
  .conf-value { color: #3b82f6; }

  input[type="range"] { width: 100%; accent-color: #3b82f6; height: 4px; }

  .btn-remove {
    background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);
    width: 32px; height: 32px; border-radius: 50%; cursor: pointer;
    font-size: 1.2rem; display: flex; align-items: center; justify-content: center;
  }
  .btn-remove:hover { background: #ef4444; color: white; transform: rotate(90deg); }

  .add-step-section { background: rgba(255, 255, 255, 0.02); padding: 32px; border-radius: 24px; border: 1px dashed rgba(255, 255, 255, 0.1); }
  .tab-header { display: flex; gap: 24px; margin-bottom: 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .tab-header button { background: none; border: none; color: #64748b; padding: 12px 0; cursor: pointer; font-weight: 700; font-size: 0.9rem; position: relative; }
  .tab-header button.active { color: #3b82f6; }
  .tab-header button.active::after { content: ''; position: absolute; bottom: -1px; left: 0; width: 100%; height: 2px; background: #3b82f6; }

  .search-box input { width: 100%; padding: 16px 20px; border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(15, 23, 42, 0.6); color: white; margin-bottom: 16px; }
  .result-item { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: rgba(255, 255, 255, 0.03); border-radius: 12px; margin-bottom: 8px; }
  .btn-add-result { background: #3b82f6; color: white; border: none; width: 32px; height: 32px; border-radius: 8px; font-size: 1.4rem; cursor: pointer; }

  .create-form { display: flex; flex-direction: column; gap: 16px; }
  .create-form input, .create-form textarea { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.1); color: white; padding: 14px; border-radius: 10px; }
  .btn-create { padding: 14px; background: #3b82f6; color: white; border: none; border-radius: 10px; font-weight: 700; cursor: pointer; }

  .empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #64748b; text-align: center; gap: 16px; }
  .welcome-icon { font-size: 4rem; }
  .spinner { width: 40px; height: 40px; border: 3px solid rgba(59, 130, 246, 0.2); border-top-color: #3b82f6; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
