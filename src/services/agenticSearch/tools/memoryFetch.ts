import { type VibeMemoryFetchInput, fetchVibeMemory } from '../../vibeMemoryLookup.js';

export async function runMemoryFetch(args: VibeMemoryFetchInput): Promise<Record<string, unknown>> {
  return (await fetchVibeMemory(args)) as unknown as Record<string, unknown>;
}
