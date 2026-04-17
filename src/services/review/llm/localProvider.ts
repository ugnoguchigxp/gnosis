import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../../../config.js';
import { type LocalLlmAlias, resolveLauncherPlan } from '../../../scripts/local-llm-cli.js';
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
  // Opt-in escape hatch for debugging only.
  return !isTruthy(env.GNOSIS_REVIEW_ALLOW_UNSAFE_MLX_IN_SEATBELT);
}

export function buildLocalProviderSpawnEnv(
  alias: LocalLlmAlias,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...sourceEnv };
  if (shouldForceSafeSeatbeltMlx(alias, sourceEnv)) {
    // Avoid native abort dialogs from MLX initialization in seatbelt.
    env.LOCAL_LLM_ALLOW_MLX_IN_SEATBELT = '0';
  }
  return env;
}

function collectStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve('');

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function spawnCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  onStart?: (pid: number | undefined) => void,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onStart?.(child.pid);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    Promise.all([collectStream(child.stdout), collectStream(child.stderr)])
      .then(([stdout, stderr]) => {
        child.once('close', (code) => {
          clearTimeout(timer);
          if (timedOut) {
            reject(new ReviewError('E006', `LLM request timed out after ${timeoutMs}ms`));
            return;
          }
          resolve({ stdout, stderr, code });
        });
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isReviewDebugEnabled(): boolean {
  const raw = process.env.GNOSIS_REVIEW_DEBUG?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function sanitizeArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    if (index > 0 && args[index - 1] === '--prompt') {
      return `<redacted-prompt:${arg.length}chars>`;
    }
    return arg;
  });
}

function toSingleLine(text: string, limit = 400): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function classifyLocalLlmCrash(stderr: string): string | null {
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes('nsrangeexception') &&
    normalized.includes('libmlx') &&
    normalized.includes('terminating app')
  ) {
    return 'MLX runtime crashed during initialization (outside MCP path). Verify local-llm runtime/Metal environment.';
  }
  return null;
}

function emitReviewDebugLog(payload: Record<string, unknown>): void {
  if (!isReviewDebugEnabled()) return;
  console.error(`[review-debug] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
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
      const forcedSafeSeatbeltMlx =
        shouldForceSafeSeatbeltMlx(alias, process.env) &&
        isTruthy(process.env.LOCAL_LLM_ALLOW_MLX_IN_SEATBELT);

      emitReviewDebugLog({
        event: 'local_provider_spawn_start',
        callId,
        invoker,
        alias,
        timeoutMs,
        forcedSafeSeatbeltMlx,
        command: plan.command,
        args: sanitizeArgs(plan.args),
      });

      const result = await spawnCommand(
        plan.command,
        plan.args,
        timeoutMs,
        spawnEnv,
        (childPid) => {
          pid = childPid;
          emitReviewDebugLog({
            event: 'local_provider_spawned',
            callId,
            invoker,
            alias,
            pid,
          });
        },
      );

      const durationMs = Date.now() - startedAt;
      emitReviewDebugLog({
        event: 'local_provider_spawn_end',
        callId,
        invoker,
        alias,
        pid,
        exitCode: result.code,
        durationMs,
        stderrPreview: toSingleLine(result.stderr),
        stdoutLength: result.stdout.length,
      });

      if (result.code !== 0) {
        const classified = classifyLocalLlmCrash(result.stderr);
        throw new ReviewError(
          'E007',
          [
            classified,
            result.stderr.trim() || `Local LLM (${alias}) exited with code ${result.code}`,
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
