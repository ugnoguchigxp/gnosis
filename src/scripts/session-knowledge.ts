#!/usr/bin/env bun

import { closeDbPool } from '../db/index.js';
import {
  approveSessionKnowledgeCandidate,
  recordSessionKnowledgeCandidate,
  rejectSessionKnowledgeCandidate,
} from '../services/sessionKnowledge/approval.js';
import { listCandidatesBySession } from '../services/sessionSummary/repository.js';

function getArg(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(key);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function requireArg(argv: string[], key: string): string {
  const value = getArg(argv, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

async function run(argv: string[]) {
  const command = argv[0];
  const asJson = argv.includes('--json');

  if (command === 'list') {
    const sessionId = requireArg(argv, '--session-id');
    const result = await listCandidatesBySession(sessionId);
    console.log(
      asJson ? JSON.stringify(result, null, 2) : `candidates=${result.candidates.length}`,
    );
    return;
  }

  if (command === 'approve') {
    const candidateId = requireArg(argv, '--candidate-id');
    const updated = await approveSessionKnowledgeCandidate(candidateId);
    console.log(asJson ? JSON.stringify(updated, null, 2) : `approved: ${candidateId}`);
    return;
  }

  if (command === 'reject') {
    const candidateId = requireArg(argv, '--candidate-id');
    const reason = requireArg(argv, '--reason');
    const updated = await rejectSessionKnowledgeCandidate(candidateId, reason);
    console.log(asJson ? JSON.stringify(updated, null, 2) : `rejected: ${candidateId}`);
    return;
  }

  if (command === 'record') {
    const candidateId = requireArg(argv, '--candidate-id');
    const result = await recordSessionKnowledgeCandidate(candidateId);
    console.log(asJson ? JSON.stringify(result, null, 2) : `recorded: ${result.promotedNoteId}`);
    return;
  }

  throw new Error(
    'Usage: bun src/scripts/session-knowledge.ts <list|approve|reject|record> [--session-id <id>] [--candidate-id <id>] [--reason <text>] [--json]',
  );
}

if (import.meta.main) {
  run(process.argv.slice(2))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    })
    .finally(async () => {
      await closeDbPool();
    });
}
