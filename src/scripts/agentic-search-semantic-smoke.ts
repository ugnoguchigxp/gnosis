#!/usr/bin/env bun

import { recordQualityGate } from '../../scripts/lib/quality-gates.js';
import { AgenticSearchRunner } from '../services/agenticSearch/runner.js';

type SmokeResult = {
  ok: boolean;
  answerChars: number;
  degradedCode?: string;
  toolCalls: number;
  loopCount: number;
};

function renderResult(result: SmokeResult, json: boolean): string {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  if (result.ok) {
    return `agentic-search semantic smoke passed: tool_calls=${result.toolCalls} loops=${result.loopCount}\n`;
  }
  return [
    'agentic-search semantic smoke failed',
    `answerChars=${result.answerChars}`,
    `degradedCode=${result.degradedCode ?? 'none'}`,
    '',
  ].join('\n');
}

async function run(): Promise<void> {
  const json = process.argv.includes('--json');
  const runner = new AgenticSearchRunner();
  const output = await runner.run({
    userRequest: 'Gnosis の agentic_search 改善で守るべき現行ルールを確認して',
    repoPath: process.cwd(),
    changeTypes: ['mcp'],
    technologies: ['TypeScript', 'Bun', 'MCP'],
    intent: 'plan',
  });
  const answerChars = output.answer.trim().length;
  const ok = answerChars > 0 && !output.degraded;
  const result: SmokeResult = {
    ok,
    answerChars,
    degradedCode: output.degraded?.code,
    toolCalls: output.toolTrace.toolCalls.length,
    loopCount: output.toolTrace.loopCount,
  };

  if (ok) {
    recordQualityGate(
      'semanticSmoke',
      'passed',
      `agentic-search semantic smoke passed (${result.toolCalls} tool calls)`,
    );
    process.stdout.write(renderResult(result, json));
    return;
  }

  recordQualityGate(
    'semanticSmoke',
    'failed',
    `agentic-search semantic smoke failed (answer chars=${result.answerChars}, degraded=${
      result.degradedCode ?? 'none'
    })`,
  );
  process.stderr.write(renderResult(result, json));
  process.exitCode = 1;
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  recordQualityGate('semanticSmoke', 'failed', message);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
