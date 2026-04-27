import type { ToolEntry } from '../registry.js';
import { agentFirstTools } from './agentFirst.js';
import { experienceTools } from './experience.js';
import { generateImplementationPlanTools } from './generateImplementationPlan.js';
import { graphTools } from './graph.js';
import { guidanceTools } from './guidance.js';
import { hookTools } from './hook.js';
import { knowflowTools } from './knowflow.js';
import { knowledgeTools } from './knowledge.js';
import { memoryTools } from './memory.js';
import { queryProcedureTools } from './queryProcedure.js';
import { recordOutcomeTools } from './recordOutcome.js';
import { reviewTools } from './review.js';
import { reviewDocumentTools } from './reviewDocument.js';
import { reviewFeedbackTools } from './reviewFeedback.js';
import { reviewGuidanceTools } from './reviewGuidance.js';
import { reviewImplementationPlanTools } from './reviewImplementationPlan.js';
import { reviewSpecDocumentTools } from './reviewSpecDocument.js';
import { syncTools } from './sync.js';

export const toolEntries: ToolEntry[] = [
  ...agentFirstTools,
  ...memoryTools,
  ...graphTools,
  ...knowledgeTools,
  ...knowflowTools,
  ...experienceTools,
  ...generateImplementationPlanTools,
  ...syncTools,
  ...guidanceTools,
  ...hookTools,
  ...queryProcedureTools,
  ...recordOutcomeTools,
  ...reviewFeedbackTools,
  ...reviewGuidanceTools,
  ...reviewImplementationPlanTools,
  ...reviewSpecDocumentTools,
  ...reviewTools,
  ...reviewDocumentTools,
];

const PRIMARY_TOOL_NAMES = new Set<string>([
  'initial_instructions',
  'activate_project',
  'start_task',
  'search_knowledge',
  'record_task_note',
  'finish_task',
  'review_task',
  'doctor',
]);

const COMPAT_VISIBLE_TOOL_NAMES = new Set<string>(['search_knowledge_legacy']);

export function getExposedToolEntries(): ToolEntry[] {
  const exposure = process.env.GNOSIS_MCP_TOOL_EXPOSURE?.trim().toLowerCase();
  if (exposure === 'all') return toolEntries;
  return toolEntries.filter(
    (tool) => PRIMARY_TOOL_NAMES.has(tool.name) || COMPAT_VISIBLE_TOOL_NAMES.has(tool.name),
  );
}
