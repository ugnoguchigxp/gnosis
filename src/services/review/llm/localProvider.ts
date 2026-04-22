import { randomUUID } from 'node:crypto';
import { config } from '../../../config.js';
import { type LocalLlmAlias, resolveLauncherPlan } from '../../../scripts/local-llm-cli.js';
import { runLlmProcess } from '../../llm/spawnControl.js';
import { REVIEW_LIMITS, ReviewError } from '../errors.js';
import type { ReviewLLMService } from './types.js';

type LocalProviderOptions = {
  alias?: LocalLlmAlias;
  scriptPath?: string;
  timeoutMs?: number;
  invoker?: 'mcp' | 'cli' | 'service' | 'unknown';
  requestId?: string;
};

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function shouldForceSafeSeatbeltMlx(alias: LocalLlmAlias, env: NodeJS.ProcessEnv): boolean {
  if (alias !== 'gemma4' && alias !== 'bonsai') return false;
  if (env.CODEX_SANDBOX !== 'seatbelt') return false;
  return !isTruthy(env.GNOSIS_REVIEW_ALLOW_UNSAFE_MLX_IN_SEATBELT);
}

export function buildLocalProviderSpawnEnv(
  alias: LocalLlmAlias,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...sourceEnv };
  if (shouldForceSafeSeatbeltMlx(alias, sourceEnv)) {
    env.LOCAL_LLM_ALLOW_MLX_IN_SEATBELT = '0';
  }
  return env;
}

function isReviewDebugEnabled(): boolean {
  const raw = process.env.GNOSIS_REVIEW_DEBUG?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function classifyLocalLlmCrash(stderr: string): string | null {
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes('nsrangeexception') &&
    normalized.includes('libmlx') &&
    normalized.includes('terminating app')
  ) {
    return 'MLX runtime crashed during initialization. Verify local-llm runtime/Metal environment.';
  }
  return null;
}

function emitReviewDebugLog(payload: Record<string, unknown>): void {
  if (!isReviewDebugEnabled()) return;
  console.error(`[review-debug] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function toSingleLine(text: string, limit = 400): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function sanitizeArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    if (index > 0 && args[index - 1] === '--prompt') {
      return `<redacted-prompt:${arg.length}chars>`;
    }
    return arg;
  });
}

export function createLocalReviewLLMService(options: LocalProviderOptions = {}): ReviewLLMService {
  const alias = options.alias ?? 'gemma4';
  const timeoutMs = options.timeoutMs ?? REVIEW_LIMITS.LLM_TIMEOUT_MS;
  const invoker = options.invoker ?? 'unknown';

  return {
    provider: 'local',
    async generate(prompt: string, opts = {}): Promise<string> {
      const outputFormat = opts.format ?? 'text';
      const plan = resolveLauncherPlan(alias, ['--output', outputFormat, '--prompt', prompt]);
      const callId = options.requestId ? `${options.requestId}:${randomUUID()}` : randomUUID();
      const startedAt = Date.now();
      let pid: number | undefined;
      const spawnEnv = buildLocalProviderSpawnEnv(alias);

      emitReviewDebugLog({
        event: 'local_provider_spawn_start',
        callId,
        invoker,
        alias,
        timeoutMs,
        command: plan.command,
        args: sanitizeArgs(plan.args),
      });

      const result = await runLlmProcess(plan.command, plan.args, {
        timeout: timeoutMs,
        env: spawnEnv,
        onStart: (childPid) => {
          pid = childPid;
          emitReviewDebugLog({
            event: 'local_provider_spawned',
            callId,
            invoker,
            alias,
            pid,
          });
        },
      });

      const durationMs = Date.now() - startedAt;
      emitReviewDebugLog({
        event: 'local_provider_spawn_end',
        callId,
        invoker,
        alias,
        pid,
        exitCode: result.status,
        durationMs,
        stderrPreview: toSingleLine(result.stderr),
        stdoutLength: result.stdout.length,
      });

      if (result.status !== 0) {
        const classified = classifyLocalLlmCrash(result.stderr);
        throw new ReviewError(
          'E007',
          [
            classified,
            result.stderr.trim() || `Local LLM (${alias}) exited with code ${result.status}`,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      return result.stdout.trim();
    },
  };
}

export const localReviewLLMService = createLocalReviewLLMService();
