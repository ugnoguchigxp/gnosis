#!/usr/bin/env bun

import { startMcpHost } from '../mcp/host.js';

startMcpHost().catch((error) => {
  console.error('[McpHost] Fatal start error:', error);
  process.exit(1);
});
