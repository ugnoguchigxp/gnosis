import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewError } from '../errors.js';
import type { Finding, ReviewContextV1, ReviewContextV2, ReviewContextV3 } from '../types.js';
import { createCloudReviewLLMService } from './cloudProvider.js';
import {
  generateFingerprint,
  softenLocalLLMFindings,
  validateFindingsBasic,
} from './hallucinator.js';
import { createLocalReviewLLMService } from './localProvider.js';
import { buildReviewPrompt, buildReviewPromptV1, buildReviewPromptV3 } from './promptBuilder.js';
import type { ReviewLLMPreference, ReviewLLMService, ReviewerAlias } from './types.js';

type ReviewLlmRuntimeOptions = {
  invoker?: 'mcp' | 'cli' | 'service' | 'unknown';
  requestId?: string;
  timeoutMs?: number;
  disableFallback?: boolean;
};

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
let reviewEnvLoaded = false;

function loadReviewEnvFile(filePath = path.join(ROOT_DIR, '.env')): void {
  if (reviewEnvLoaded) return;
  reviewEnvLoaded = true;
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex <= 0) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    const rawValue = trimmed.slice(equalIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function syncAzureEndpointToGnosisBaseUrl(): void {
  if (
    !process.env.GNOSIS_REVIEW_LLM_API_BASE_URL &&
    process.env.AZURE_OPENAI_ENDPOINT?.trim().length
  ) {
    process.env.GNOSIS_REVIEW_LLM_API_BASE_URL = process.env.AZURE_OPENAI_ENDPOINT;
  }
}

function extractJsonPayload(rawOutput: string): string {
  const fenced = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) {
    return fenced[1].trim();
  }

  const trimmed = rawOutput.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  return objectMatch?.[0] ?? trimmed;
}

function toTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeFinding(
  candidate: unknown,
  index: number,
  source: Finding['source'],
): Finding | null {
  if (!candidate || typeof candidate !== 'object') return null;

  const raw = candidate as Record<string, unknown>;
  const severity = raw.severity;
  const confidence = raw.confidence;
  const category = raw.category;

  if (typeof raw.file_path !== 'string' || typeof raw.rationale !== 'string') {
    return null;
  }

  return {
    id:
      typeof raw.id === 'string' && raw.id.trim()
        ? raw.id
        : `f-${String(index + 1).padStart(3, '0')}`,
    title: typeof raw.title === 'string' ? raw.title : '',
    severity:
      severity === 'error' || severity === 'warning' || severity === 'info' ? severity : 'info',
    confidence:
      confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : 'low',
    file_path: raw.file_path,
    line_new: typeof raw.line_new === 'number' ? raw.line_new : Number(raw.line_new ?? 0),
    end_line: typeof raw.end_line === 'number' ? raw.end_line : undefined,
    category:
      category === 'bug' ||
      category === 'security' ||
      category === 'performance' ||
      category === 'design' ||
      category === 'maintainability' ||
      category === 'test' ||
      category === 'validation'
        ? category
        : 'maintainability',
    rationale: raw.rationale,
    suggested_fix: typeof raw.suggested_fix === 'string' ? raw.suggested_fix : undefined,
    evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
    knowledge_refs: Array.isArray(raw.knowledge_refs)
      ? raw.knowledge_refs.filter((item): item is string => typeof item === 'string')
      : undefined,
    knowledge_basis:
      raw.knowledge_basis === 'static_analysis' ||
      raw.knowledge_basis === 'novel_issue' ||
      raw.knowledge_basis === 'no_applicable_knowledge'
        ? raw.knowledge_basis
        : undefined,
    fingerprint: '',
    needsHumanConfirmation: Boolean(raw.needsHumanConfirmation),
    source,
  };
}

/**
 * resolves the reviewer alias from environment variables.
 */
export function resolveReviewerAlias(): ReviewerAlias {
  const env = process.env.GNOSIS_REVIEWER?.trim().toLowerCase();
  if (
    env === 'gemma4' ||
    env === 'qwen' ||
    env === 'bonsai' ||
    env === 'bedrock' ||
    env === 'openai' ||
    env === 'azure-openai'
  ) {
    return env as ReviewerAlias;
  }
  return 'azure-openai';
}

/**
 * Resolves the reviewer LLM service based on environment variables.
 * Preference argument is kept for compatibility but overridden by GNOSIS_REVIEWER if set.
 */
export async function getReviewLLMService(
  preference?: ReviewLLMPreference,
  runtime: ReviewLlmRuntimeOptions = {},
): Promise<ReviewLLMService> {
  loadReviewEnvFile();
  syncAzureEndpointToGnosisBaseUrl();

  const alias = resolveReviewerAlias();
  const invoker = runtime.invoker ?? 'service';
  const requestId = runtime.requestId;

  // If the caller explicitly asks local/cloud, that intent should win.
  // Otherwise resolve through GNOSIS_REVIEWER, falling back to Azure OpenAI.
  const useAlias = preference === undefined;

  if (useAlias) {
    switch (alias) {
      case 'gemma4':
        return createLocalReviewLLMService({
          alias: 'gemma4',
          invoker,
          requestId,
          timeoutMs: runtime.timeoutMs,
        });
      case 'qwen':
        return createLocalReviewLLMService({
          alias: 'qwen',
          invoker,
          requestId,
          timeoutMs: runtime.timeoutMs,
        });
      case 'bonsai':
        return createLocalReviewLLMService({
          alias: 'bonsai',
          invoker,
          requestId,
          timeoutMs: runtime.timeoutMs,
        });
      case 'bedrock':
        return createCloudReviewLLMService({ provider: 'bedrock', timeoutMs: runtime.timeoutMs });
      case 'openai':
        return createCloudReviewLLMService({
          provider: 'azure-openai',
          timeoutMs: runtime.timeoutMs,
        });
      case 'azure-openai':
        return createCloudReviewLLMService({
          provider: 'azure-openai',
          timeoutMs: runtime.timeoutMs,
        });
    }
  }

  // Legacy fallback logic
  const pref =
    preference ?? (process.env.GNOSIS_REVIEW_LLM_PREFERENCE === 'local' ? 'local' : 'cloud');
  const local = createLocalReviewLLMService({
    alias: 'gemma4',
    invoker,
    requestId,
    timeoutMs: runtime.timeoutMs,
  });
  const cloudFallback = () =>
    createCloudReviewLLMService({
      provider: pref === 'openai' ? 'azure-openai' : pref === 'bedrock' ? 'bedrock' : undefined,
      timeoutMs: runtime.timeoutMs,
    });

  if (pref === 'local') {
    return {
      provider: 'local',
      async generate(prompt: string, options?: { format?: 'json' | 'text' }): Promise<string> {
        try {
          return await local.generate(prompt, options);
        } catch (error) {
          if (runtime.disableFallback) throw error;
          if (error instanceof ReviewError && (error.code === 'E006' || error.code === 'E007')) {
            return cloudFallback().generate(prompt, options);
          }
          throw error;
        }
      },
      async generateMessages(messages, options) {
        if (local.generateMessages) {
          return local.generateMessages(messages, options);
        }
        // Fallback to text generate
        const prompt = messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n');
        return local.generate(prompt, options);
      },
      async generateMessagesStructured(messages, options) {
        if (local.generateMessagesStructured) {
          return local.generateMessagesStructured(messages, options);
        }
        throw new ReviewError('E007', 'Local LLM does not support structured tool calls');
      },
    };
  }

  if (pref === 'openai' || pref === 'bedrock' || pref === 'azure-openai') {
    try {
      const cloud = createCloudReviewLLMService({
        provider: pref === 'openai' ? 'azure-openai' : pref,
        timeoutMs: runtime.timeoutMs,
      });
      return {
        provider: 'cloud',
        async generate(prompt: string, options?: { format?: 'json' | 'text' }): Promise<string> {
          return cloud.generate(prompt, options);
        },
        async generateMessages(messages, options) {
          if (cloud.generateMessages) {
            return cloud.generateMessages(messages, options);
          }
          return cloud.generate('', options);
        },
        async generateMessagesStructured(messages, options) {
          if (cloud.generateMessagesStructured) {
            return cloud.generateMessagesStructured(messages, options);
          }
          throw new ReviewError('E007', 'Cloud LLM does not support structured tool calls');
        },
      };
    } catch (error) {
      if (runtime.disableFallback) throw error;
      if (error instanceof ReviewError) {
        return local;
      }
      throw new ReviewError('E007', `No review LLM providers available: ${error}`);
    }
  }

  try {
    const cloud = createCloudReviewLLMService({ timeoutMs: runtime.timeoutMs });
    return {
      provider: 'cloud',
      async generate(prompt: string, options?: { format?: 'json' | 'text' }): Promise<string> {
        try {
          return await cloud.generate(prompt, options);
        } catch (error) {
          if (runtime.disableFallback) throw error;
          if (error instanceof ReviewError && (error.code === 'E007' || error.code === 'E006')) {
            return local.generate(prompt, options);
          }
          throw error;
        }
      },
      async generateMessages(messages, options) {
        if (cloud.generateMessages) {
          return cloud.generateMessages(messages, options);
        }
        return cloud.generate('', options); // Should not happen with cloud
      },
      async generateMessagesStructured(messages, options) {
        if (cloud.generateMessagesStructured) {
          return cloud.generateMessagesStructured(messages, options);
        }
        throw new ReviewError('E007', 'Cloud LLM does not support structured tool calls');
      },
    };
  } catch (error) {
    if (error instanceof ReviewError) {
      return local;
    }
    throw new ReviewError('E007', `No review LLM providers available: ${error}`);
  }
}

export async function reviewWithLLM(
  context: ReviewContextV1 | ReviewContextV2 | ReviewContextV3,
  llmService: ReviewLLMService,
): Promise<{ findings: Finding[]; summary: string; next_actions: string[] }> {
  const prompt =
    'recalledPrinciples' in context
      ? buildReviewPromptV3(context)
      : 'diffSummary' in context
        ? buildReviewPrompt(context)
        : buildReviewPromptV1(context.rawDiff, context.projectInfo, context.instruction);

  let rawOutput: string;
  try {
    rawOutput = await llmService.generate(prompt, { format: 'json' });
  } catch (error) {
    if (error instanceof ReviewError && error.code === 'E006') {
      return { findings: [], summary: 'Review timed out', next_actions: [] };
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(rawOutput));
  } catch {
    return {
      findings: [],
      summary: rawOutput.trim().slice(0, 200),
      next_actions: [],
    };
  }

  const source: Finding['source'] = llmService.provider === 'local' ? 'local_llm' : 'heavy_llm';
  const candidates = Array.isArray((parsed as { findings?: unknown }).findings)
    ? ((parsed as { findings?: unknown }).findings as unknown[])
    : [];

  const normalized = candidates
    .map((candidate, index) => normalizeFinding(candidate, index, source))
    .filter((finding): finding is Finding => finding !== null);

  const findings = validateFindingsBasic(normalized, context.rawDiff).map((finding) => ({
    ...finding,
    fingerprint: generateFingerprint(finding),
  }));

  const softenedFindings =
    llmService.provider === 'local' ? softenLocalLLMFindings(findings) : findings;

  const summaryCandidate = (parsed as { summary?: unknown }).summary;
  const summary =
    typeof summaryCandidate === 'string' && summaryCandidate.trim() ? summaryCandidate.trim() : '';

  return {
    findings: softenedFindings,
    summary,
    next_actions: toTextList((parsed as { next_actions?: unknown }).next_actions),
  };
}
