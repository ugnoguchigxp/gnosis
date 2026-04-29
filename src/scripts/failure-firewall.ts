#!/usr/bin/env bun

import { runFailureFirewallCli } from '../services/failureFirewall/cli.js';

runFailureFirewallCli().catch((error) => {
  console.error('Failure Firewall failed:', error);
  process.exit(1);
});
