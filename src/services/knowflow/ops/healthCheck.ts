import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { type LlmClientConfig, config } from '../../../config.js';
import { type StructuredLogger, defaultStructuredLogger } from './logger.js';

const execAsync = promisify(exec);

export type HealthCheckResult = {
  ok: boolean;
  details: {
    api?: { ok: boolean; message?: string };
    cli?: { ok: boolean; message?: string };
  };
};

export async function checkLlmHealth(
  llmConfig: LlmClientConfig = config.knowflow.llm,
  logger: StructuredLogger = defaultStructuredLogger,
  deps: {
    exec?: (
      cmd: string,
      options: Record<string, unknown>,
    ) => Promise<{ stdout: string; stderr: string }>;
  } = {},
): Promise<HealthCheckResult> {
  const checkExec = deps.exec ?? execAsync;
  const result: HealthCheckResult = {
    ok: true,
    details: {},
  };

  // 1. API Check
  try {
    const url = new URL(llmConfig.apiPath, llmConfig.apiBaseUrl).toString();
    const controller = new AbortController();
    const timeoutMs = config.knowflow?.healthCheck?.timeoutMs ?? 5000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'OPTIONS', // Or a simple GET if supported, but typically LLM APIs use POST. OPTIONS is safe.
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);

    // If it's a 404 or 405, the server is at least there.
    // Connection refused would throw/return null.
    if (response) {
      result.details.api = { ok: true, message: `Connected to ${llmConfig.apiBaseUrl}` };
    } else {
      result.details.api = { ok: false, message: `Could not connect to ${llmConfig.apiBaseUrl}` };
      // result.ok = false; // We don't mark overall fail if CLI fallback is enabled
    }
  } catch (err) {
    result.details.api = { ok: false, message: String(err) };
  }

  // 2. CLI Check
  if (llmConfig.enableCliFallback) {
    try {
      // Extract command binary
      const cmd = llmConfig.cliCommand.split(' ')[0];
      const timeoutMs = config.knowflow?.healthCheck?.timeoutMs ?? 5000;
      await checkExec(`${cmd} --help`, { timeout: timeoutMs });
      result.details.cli = { ok: true, message: `Command '${cmd}' is available.` };
    } catch (err) {
      result.details.cli = { ok: false, message: `CLI command check failed: ${String(err)}` };
      if (!result.details.api?.ok) {
        result.ok = false; // Both failed
      }
    }
  } else if (!result.details.api?.ok) {
    result.ok = false;
  }

  if (!result.ok) {
    logger({
      event: 'worker.health_check.failed',
      details: result.details,
      level: 'error',
    });
  } else {
    logger({
      event: 'worker.health_check.ok',
      details: result.details,
      level: 'info',
    });
  }

  return result;
}
