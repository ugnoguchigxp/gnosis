#!/usr/bin/env bun

import { AgenticSearchRunner } from '../services/agenticSearch/runner.js';
import type { AgenticSearchRunnerOutput } from '../services/agenticSearch/runner.js';

type Intent = 'plan' | 'edit' | 'debug' | 'review' | 'finish';

function getArg(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(key);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function getArgs(argv: string[], key: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === key && argv[i + 1]) values.push(argv[i + 1]);
  }
  return values;
}

export type AgenticSearchCliInput = {
  userRequest: string;
  repoPath?: string;
  files: string[];
  changeTypes: string[];
  technologies: string[];
  intent?: Intent;
  asJson: boolean;
};

export function parseAgenticSearchCliArgs(argv: string[]): AgenticSearchCliInput {
  const request = getArg(argv, '--request');
  if (!request) {
    throw new Error('--request is required');
  }
  return {
    userRequest: request,
    repoPath: getArg(argv, '--repo'),
    files: getArgs(argv, '--file'),
    changeTypes: getArgs(argv, '--change-type'),
    technologies: getArgs(argv, '--technology'),
    intent: getArg(argv, '--intent') as Intent | undefined,
    asJson: argv.includes('--json'),
  };
}

export async function runAgenticSearchCli(
  argv: string[],
  deps: {
    runner?: { run: (input: Omit<AgenticSearchCliInput, 'asJson'>) => Promise<AgenticSearchRunnerOutput> };
    write?: (line: string) => void;
  } = {},
): Promise<void> {
  const parsed = parseAgenticSearchCliArgs(argv);
  const runner = deps.runner ?? new AgenticSearchRunner();
  const write = deps.write ?? ((line: string) => console.log(line));
  const result = await runner.run({
    userRequest: parsed.userRequest,
    repoPath: parsed.repoPath,
    files: parsed.files,
    changeTypes: parsed.changeTypes,
    technologies: parsed.technologies,
    intent: parsed.intent,
  });
  if (parsed.asJson) {
    write(JSON.stringify(result, null, 2));
    return;
  }
  write(result.answer);
  const callCount = result.toolTrace.toolCalls.length;
  write(`\ntrace: loops=${result.toolTrace.loopCount}, tool_calls=${callCount}`);
}

if (import.meta.main) {
  runAgenticSearchCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
