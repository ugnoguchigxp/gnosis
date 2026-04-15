#!/usr/bin/env bun

import { runReviewCli } from '../services/review/cli.js';

async function main() {
  await runReviewCli();
}

main().catch((error) => {
  console.error('Review run failed:', error);
  process.exit(1);
});
