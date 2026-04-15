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
import type { ReviewLLMPreference, ReviewLLMService } from './types.js';

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
    fingerprint: '',
    needsHumanConfirmation: Boolean(raw.needsHumanConfirmation),
    source,
  };
}

export async function getReviewLLMService(
  preference: ReviewLLMPreference = 'cloud',
): Promise<ReviewLLMService> {
  const local = createLocalReviewLLMService();
  const cloudFallback = () => createCloudReviewLLMService();

  if (preference === 'local') {
    return {
      provider: 'local',
      async generate(prompt: string, options?: { format?: 'json' | 'text' }): Promise<string> {
        try {
          return await local.generate(prompt, options);
        } catch (error) {
          if (error instanceof ReviewError && (error.code === 'E006' || error.code === 'E007')) {
            return cloudFallback().generate(prompt, options);
          }

          throw error;
        }
      },
    };
  }

  try {
    const cloud = createCloudReviewLLMService();

    return {
      provider: 'cloud',
      async generate(prompt: string, options?: { format?: 'json' | 'text' }): Promise<string> {
        try {
          return await cloud.generate(prompt, options);
        } catch (error) {
          if (error instanceof ReviewError && (error.code === 'E007' || error.code === 'E006')) {
            return local.generate(prompt, options);
          }

          throw error;
        }
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
