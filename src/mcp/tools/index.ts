import type { ToolEntry } from '../registry.js';
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
