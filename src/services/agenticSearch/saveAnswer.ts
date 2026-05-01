import { saveMemoryWithOptions } from '../memory.js';
import type { AgenticSearchRunnerInput } from './runner.js';
import type { AgenticSearchTrace } from './types.js';

function shouldSaveAnswer(): boolean {
  const raw = process.env.GNOSIS_AGENTIC_SAVE_ANSWER;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

export async function saveAgenticAnswer(args: {
  input: AgenticSearchRunnerInput;
  answer: string;
  trace: AgenticSearchTrace;
}): Promise<string | undefined> {
  if (!shouldSaveAnswer()) return undefined;
  const metadata = {
    kind: 'agentic_search_answer',
    userRequest: args.input.userRequest,
    intent: args.input.intent ?? 'edit',
    repoPath: args.input.repoPath ?? null,
    files: args.input.files ?? [],
    changeTypes: args.input.changeTypes ?? [],
    technologies: args.input.technologies ?? [],
    toolTrace: args.trace,
  };
  const saved = await saveMemoryWithOptions({
    sessionId: 'agentic_search_answers',
    content: args.answer,
    metadata,
    memoryType: 'raw',
    sourceTask: 'agentic_search',
  });
  return String(saved.id);
}
