import type { ToolEntry } from '../registry.js';
import { experienceTools } from './experience.js';
import { graphTools } from './graph.js';
import { guidanceTools } from './guidance.js';
import { knowflowTools } from './knowflow.js';
import { knowledgeTools } from './knowledge.js';
import { memoryTools } from './memory.js';
import { queryProcedureTools } from './queryProcedure.js';
import { recordOutcomeTools } from './recordOutcome.js';
import { reviewTools } from './review.js';
import { syncTools } from './sync.js';

export const toolEntries: ToolEntry[] = [
  ...memoryTools,
  ...graphTools,
  ...knowledgeTools,
  ...knowflowTools,
  ...experienceTools,
  ...syncTools,
  ...guidanceTools,
  ...queryProcedureTools,
  ...recordOutcomeTools,
  ...reviewTools,
];
