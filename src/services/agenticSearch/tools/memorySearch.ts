import { type VibeMemorySearchInput, searchVibeMemories } from '../../vibeMemoryLookup.js';

export async function runMemorySearch(
  args: VibeMemorySearchInput,
): Promise<Record<string, unknown>> {
  return (await searchVibeMemories(args)) as unknown as Record<string, unknown>;
}
