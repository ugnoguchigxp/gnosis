import type { ToolEntry } from '../registry.js';
import { agentFirstTools } from './agentFirst.js';

export const toolEntries: ToolEntry[] = [...agentFirstTools];

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

export function getExposedToolEntries(): ToolEntry[] {
  return toolEntries.filter((tool) => PRIMARY_TOOL_NAMES.has(tool.name));
}
