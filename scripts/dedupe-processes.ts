#!/usr/bin/env bun

import {
  renderProcessDedupeFindings,
  suppressDuplicateProcesses,
} from '../src/runtime/processDedupe.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const signal = args.includes('--kill') ? 'SIGKILL' : 'SIGTERM';
const keep = args.includes('--keep-oldest') ? 'oldest' : 'newest';

const findings = suppressDuplicateProcesses({
  apply,
  signal,
  keep,
});

process.stdout.write(`${renderProcessDedupeFindings(findings)}\n`);
