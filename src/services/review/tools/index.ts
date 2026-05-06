import { ReviewError } from '../errors.js';
import { lookupFailureFirewallContextToolEntry } from './failureFirewall.js';
import { getSymbolsToolEntry } from './getSymbols.js';
import {
  gitBlameToolEntry,
  gitDiffToolEntry,
  gitLogToolEntry,
  gitShowToolEntry,
} from './gitTools.js';
import {
  getGuidanceToolEntry,
  queryGraphToolEntry,
  recallLessonsToolEntry,
  searchKnowledgeToolEntry,
} from './gnosisTools.js';
import { listDirToolEntry, readFileToolEntry } from './readFile.js';
import { searchCodeToolEntry } from './searchCode.js';
import { runLintToolEntry, runTypecheckToolEntry } from './staticAnalysis.js';
import type { ReviewerToolContext, ReviewerToolEntry } from './types.js';
import { braveSearchToolEntry, fetchToolEntry, webSearchToolEntry } from './webSearch.js';

/** LLM tool definition format as expected by cloud providers */
export type LLMToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export class ReviewerToolRegistry {
  private entries: Map<string, ReviewerToolEntry> = new Map();

  register(entry: ReviewerToolEntry): void {
    this.entries.set(entry.definition.name, entry);
  }

  /** Convert to format passed to cloud LLM APIs */
  toLLMToolDefinitions(): LLMToolDefinition[] {
    return Array.from(this.entries.values()).map((e) => ({
      name: e.definition.name,
      description: e.definition.description,
      parameters: e.definition.inputSchema,
    }));
  }

  /** Get basic tool specs for pseudo tool_use prompts */
  toToolSpecList(): string[] {
    return Array.from(this.entries.values()).map(
      (e) => `- ${e.definition.name}: ${e.definition.description}`,
    );
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ReviewerToolContext,
  ): Promise<string> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new ReviewError('E012', `Unknown reviewer tool: ${name}`);
    }

    try {
      return await entry.handler(args, ctx);
    } catch (error) {
      return `[Tool '${name}' failed]: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

export function createDefaultReviewerToolRegistry(): ReviewerToolRegistry {
  const registry = new ReviewerToolRegistry();
  registry.register(readFileToolEntry);
  registry.register(listDirToolEntry);
  registry.register(searchCodeToolEntry);
  registry.register(getSymbolsToolEntry);
  registry.register(gitDiffToolEntry);
  registry.register(gitLogToolEntry);
  registry.register(gitBlameToolEntry);
  registry.register(gitShowToolEntry);
  registry.register(runTypecheckToolEntry);
  registry.register(runLintToolEntry);
  registry.register(recallLessonsToolEntry);
  registry.register(searchKnowledgeToolEntry);
  registry.register(getGuidanceToolEntry);
  registry.register(queryGraphToolEntry);
  registry.register(lookupFailureFirewallContextToolEntry);
  registry.register(webSearchToolEntry);
  registry.register(braveSearchToolEntry);
  registry.register(fetchToolEntry);
  return registry;
}
