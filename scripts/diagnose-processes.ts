#!/usr/bin/env bun

import { renderWatchdogFindings, scanWatchdog } from '../src/runtime/processWatchdog.js';

const findings = scanWatchdog({ apply: false, requireConsecutive: false });
process.stdout.write(`${renderWatchdogFindings(findings)}\n`);
