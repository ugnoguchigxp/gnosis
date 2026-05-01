import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { fetchContent, searchWeb } from '../../scripts/webTools.js';
import {
  agenticSearch,
  buildAgenticSearchTaskEnvelope,
  buildDoctorRuntimeHealth,
  recordTaskNote,
  resolveStaleMetadataSignal,
  searchKnowledgeV2,
  selectAgenticSearchPhrases,
} from '../../services/agentFirst.js';
import { runPromptWithMemoryLoopRouter } from '../../services/memoryLoopLlmRouter.js';
import type { ToolEntry } from '../registry.js';

const taskChangeTypes = [
  'frontend',
  'backend',
  'api',
  'auth',
  'db',
  'docs',
  'test',
  'mcp',
  'refactor',
  'config',
  'build',
  'review',
] as const;

const initialInstructionsSchema = z.object({});
const agenticSearchSchema = z.object({
  userRequest: z.string().min(1),
  repoPath: z.string().optional(),
  files: z.array(z.string()).optional(),
  changeTypes: z.array(z.enum(taskChangeTypes)).optional(),
  technologies: z.array(z.string()).optional(),
  intent: z.enum(['plan', 'edit', 'debug', 'review', 'finish']).optional(),
});
const searchKnowledgeSchema = z.object({
  query: z.string().optional(),
  taskGoal: z.string().optional(),
  files: z.array(z.string()).optional(),
  changeTypes: z.array(z.enum(taskChangeTypes)).optional(),
  technologies: z.array(z.string()).optional(),
  intent: z.enum(['plan', 'edit', 'debug', 'review', 'finish']).optional(),
});
const recordTaskNoteSchema = z.object({ content: z.string().min(1) });
const doctorSchema = z.object({
  clientSnapshot: z
    .array(
      z.object({
        name: z.string(),
        schemaHash: z.string().optional(),
        descriptionHash: z.string().optional(),
        schemaVersion: z.string().optional(),
        descriptionVersion: z.string().optional(),
      }),
    )
    .optional(),
});
const reviewTaskSchema = z.object({
  targetType: z.enum(['code_diff', 'document', 'implementation_plan', 'spec', 'design']),
  target: z.object({
    diff: z.string().optional(),
    filePaths: z.array(z.string()).optional(),
    content: z.string().optional(),
    documentPath: z.string().optional(),
  }),
});

type WebSearchCandidate = {
  title: string;
  url: string;
  snippet: string;
};

function extractSearchCandidates(markdown: string): WebSearchCandidate[] {
  const candidates: WebSearchCandidate[] = [];
  const seen = new Set<string>();
  const matches = markdown.matchAll(/^- (.+) \((https?:\/\/[^)\s]+)\)\n?(?:\s{2}([^\n]+))?/gm);

  for (const match of matches) {
    const url = match[2]?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({
      title: match[1]?.trim() ?? '',
      url,
      snippet: match[3]?.trim() ?? '',
    });
  }

  return candidates;
}

type SystemContext = {
  taskRequest: string;
  selectedPhrases: string[];
  maxAttempts: number;
  instruction: string;
};

const WEB_FALLBACK_MAX_ATTEMPTS = 3;

function buildSystemContext(taskRequest: string, selectedPhrases: string[]): SystemContext {
  const phraseText = selectedPhrases.length > 0 ? selectedPhrases.join(', ') : '(none)';
  return {
    taskRequest,
    selectedPhrases,
    maxAttempts: WEB_FALLBACK_MAX_ATTEMPTS,
    instruction: [
      '役割: agentic_search の候補評価。',
      '候補だけで依頼に答えられる時だけ、根拠に沿った自然文の回答を返す。',
      '回答は結論だけ。前置き禁止。',
      '不足・無関係・推測が必要な時は何も返さず、次候補へ進ませる。',
      '回答不能の説明文も返さない。',
      '最新・現在・時点の依頼は、候補に公式/一次情報と日付根拠が無ければ回答しない。',
      'Web候補は公式サイト・一次情報を優先する。',
      `Web候補確認は最大${WEB_FALLBACK_MAX_ATTEMPTS}回まで。`,
      `依頼: ${taskRequest}`,
      `検索語: ${phraseText}`,
    ].join('\n'),
  };
}

function formatAgenticSearchContent(retrieval: {
  usedKnowledge?: Array<{ title?: string; summary?: string; reason?: string }>;
}): string {
  return (retrieval.usedKnowledge ?? [])
    .map((item, index) =>
      [
        `candidate ${index + 1}`,
        `title: ${item.title ?? ''}`,
        `summary: ${item.summary ?? ''}`,
        `reason: ${item.reason ?? ''}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function buildEvaluationPrompt(
  systemContext: SystemContext,
  sourceLabel: string,
  content: string,
): string {
  return [
    systemContext.instruction,
    '補足説明・JSON・ラベルは禁止。',
    `候補種別: ${sourceLabel}`,
    '候補本文:',
    content,
  ].join('\n');
}

function buildWebCandidateSelectionPrompt(
  systemContext: SystemContext,
  candidates: WebSearchCandidate[],
): string {
  return [
    systemContext.instruction,
    '次にfetchするWeb候補を1つ選ぶ。',
    '公式サイト・一次情報と思える候補を優先する。',
    '返答は選んだURLだけ。説明は禁止。選べない時は空。',
    '候補:',
    candidates
      .map(
        (candidate, index) =>
          `${index + 1}. title: ${candidate.title}\nurl: ${candidate.url}\nsnippet: ${
            candidate.snippet
          }`,
      )
      .join('\n'),
  ].join('\n');
}

async function orderWebCandidates(
  systemContext: SystemContext,
  candidates: WebSearchCandidate[],
): Promise<WebSearchCandidate[]> {
  if (candidates.length <= 1) return candidates;
  try {
    const routed = await runPromptWithMemoryLoopRouter({
      prompt: buildWebCandidateSelectionPrompt(systemContext, candidates),
      taskKind: 'evaluation',
      llmTimeoutMs: 60_000,
    });
    const selected = candidates.find((candidate) => routed.output.includes(candidate.url));
    if (!selected) return candidates;
    return [selected, ...candidates.filter((candidate) => candidate.url !== selected.url)];
  } catch {
    return candidates;
  }
}

function isCandidateRejection(answer: string): boolean {
  const normalized = answer.replace(/\s+/g, '').toLowerCase();
  return [
    '[system]toolcallorthinkblockwasgeneratedbutfailedtoparse',
    '<|channel>thought',
    '<channel|>',
    '候補だけでは',
    '答えられません',
    '答えられない',
    '回答できません',
    '回答できない',
    '特定できません',
    '判断できません',
    '情報が不足',
    '情報不足',
    '根拠がありません',
    '根拠がない',
    'わかりません',
    '不明です',
    'noanswer',
    'cannotanswer',
    'insufficientinformation',
    'notenoughinformation',
  ].some((marker) => normalized.includes(marker));
}

async function evaluateCandidateAnswer(
  systemContext: SystemContext,
  sourceLabel: string,
  content: string,
): Promise<{ answerable: boolean; answer: string }> {
  if (content.trim().length === 0) return { answerable: false, answer: '' };
  try {
    const prompt = buildEvaluationPrompt(systemContext, sourceLabel, content);
    const routed = await runPromptWithMemoryLoopRouter({
      prompt,
      taskKind: 'evaluation',
      llmTimeoutMs: 60_000,
    });
    const answer = routed.output.trim();
    if (answer.length === 0) return { answerable: false, answer: '' };
    if (isCandidateRejection(answer)) return { answerable: false, answer: '' };
    return { answerable: true, answer };
  } catch {
    return { answerable: false, answer: '' };
  }
}

export const agentFirstTools: ToolEntry[] = [
  {
    name: 'initial_instructions',
    description: 'Agent-First の最小運用ルールを返す。',
    inputSchema: zodToJsonSchema(initialInstructionsSchema) as Record<string, unknown>,
    handler: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              defaultKnowledgeTool: 'agentic_search',
              rawSearchTool: 'search_knowledge',
              reviewTool: 'review_task',
              saveKnowledgeTool: 'record_task_note',
              diagnosticTool: 'doctor',
            },
            null,
            2,
          ),
        },
      ],
    }),
  },
  {
    name: 'agentic_search',
    description: 'JSON入力を解析し、agenticSearchと必要時Web fallbackを実行する。',
    inputSchema: zodToJsonSchema(agenticSearchSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = agenticSearchSchema.parse(args);
      const task = buildAgenticSearchTaskEnvelope(input);
      const selectedPhrases = selectAgenticSearchPhrases(task);
      const systemContext = buildSystemContext(task.request, selectedPhrases);
      const retrieval = await agenticSearch({ ...input, queryPhrases: selectedPhrases });
      const agenticAnswer = await evaluateCandidateAnswer(
        systemContext,
        'agenticSearchResult',
        formatAgenticSearchContent(retrieval),
      );

      if (agenticAnswer.answerable) {
        return {
          content: [
            {
              type: 'text',
              text: agenticAnswer.answer,
            },
          ],
        };
      }

      const query = [task.request, ...selectedPhrases].join(' ');
      const webResult = await searchWeb(query);
      const candidates = await orderWebCandidates(
        systemContext,
        extractSearchCandidates(webResult),
      );
      let attempts = 0;
      for (const candidate of candidates) {
        if (attempts >= systemContext.maxAttempts) break;
        attempts += 1;
        const content = await fetchContent(candidate.url);
        const judged = await evaluateCandidateAnswer(
          systemContext,
          'fetchedContent',
          [
            `title: ${candidate.title}`,
            `url: ${candidate.url}`,
            `snippet: ${candidate.snippet}`,
            'content:',
            content,
          ].join('\n'),
        );
        if (!judged.answerable) continue;
        return {
          content: [
            {
              type: 'text',
              text: judged.answer,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: '結果が見つかりませんでした。',
          },
        ],
      };
    },
  },
  {
    name: 'search_knowledge',
    description: 'raw候補確認用。',
    inputSchema: zodToJsonSchema(searchKnowledgeSchema) as Record<string, unknown>,
    handler: async (args) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(await searchKnowledgeV2(searchKnowledgeSchema.parse(args)), null, 2),
        },
      ],
    }),
  },
  {
    name: 'record_task_note',
    description: '知見保存。',
    inputSchema: zodToJsonSchema(recordTaskNoteSchema) as Record<string, unknown>,
    handler: async (args) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(await recordTaskNote(recordTaskNoteSchema.parse(args)), null, 2),
        },
      ],
    }),
  },
  {
    name: 'review_task',
    description: '最小モードではレビュー機能を提供しない。',
    inputSchema: zodToJsonSchema(reviewTaskSchema) as Record<string, unknown>,
    handler: async (args) => {
      void reviewTaskSchema.parse(args);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'unavailable_in_minimal_mode' }, null, 2),
          },
        ],
      };
    },
  },
  {
    name: 'doctor',
    description: 'ランタイム/メタデータ状態を返す。',
    inputSchema: zodToJsonSchema(doctorSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = doctorSchema.parse(args);
      const staleMetadata = await resolveStaleMetadataSignal({
        clientSnapshot: input.clientSnapshot,
      });
      const runtime = await buildDoctorRuntimeHealth();
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...runtime, staleMetadata }, null, 2) }],
      };
    },
  },
];
