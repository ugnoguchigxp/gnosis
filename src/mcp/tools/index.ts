import type { ToolEntry } from '../registry.js';
import { agentFirstTools } from './agentFirst.js';

export const toolEntries: ToolEntry[] = [...agentFirstTools];

const PRIMARY_TOOL_NAMES = new Set<string>([
  'initial_instructions',
  'agentic_search',
  'search_knowledge',
  'record_task_note',
  'review_task',
  'doctor',
  'memory_search',
  'memory_fetch',
]);

export function getExposedToolEntries(): ToolEntry[] {
  return toolEntries.filter((tool) => PRIMARY_TOOL_NAMES.has(tool.name));
}
