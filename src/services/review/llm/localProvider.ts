import { spawn } from 'node:child_process';
import { config } from '../../../config.js';
import { REVIEW_LIMITS, ReviewError } from '../errors.js';
import type { ReviewLLMService } from './types.js';

type LocalProviderOptions = {
  scriptPath?: string;
  timeoutMs?: number;
};

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
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

export function createLocalReviewLLMService(options: LocalProviderOptions = {}): ReviewLLMService {
  const scriptPath = options.scriptPath ?? config.llmScript;
  const timeoutMs = options.timeoutMs ?? REVIEW_LIMITS.LLM_TIMEOUT_MS;

  return {
    provider: 'local',
    async generate(prompt: string, opts = {}): Promise<string> {
      const outputFormat = opts.format ?? 'text';
      const result = await spawnCommand(
        scriptPath,
        ['--output', outputFormat, '--prompt', prompt],
        timeoutMs,
      );

      if (result.code !== 0) {
        throw new ReviewError(
          'E007',
          result.stderr.trim() || `Local LLM exited with code ${result.code}`,
        );
      }

      return result.stdout.trim();
    },
  };
}

export const localReviewLLMService = createLocalReviewLLMService();
