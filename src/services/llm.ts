import { z } from 'zod';
import { config } from '../config.js';

import {
  DistilledKnowledgeSchema,
  ExtractedEntitySchema,
  MergedEntityResultSchema,
} from '../domain/schemas.js';
import type { DistilledKnowledge, ExtractedEntity, MergedEntityResult } from '../domain/schemas.js';
import { runPromptWithMemoryLoopRouter } from './memoryLoopLlmRouter.js';

export type SpawnSyncResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

export type SpawnSyncFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { encoding: 'utf-8'; env?: NodeJS.ProcessEnv; timeout?: number },
) => SpawnSyncResult;

export type LlmServiceDeps = {
  spawnSync?: SpawnSyncFn;
  llmScript?: string;
  llmTimeoutMs?: number;
  withLock?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { runLlmProcessSync } from './llm/spawnControl.js';

const defaultSpawnSync: SpawnSyncFn = (command, args, options) => {
  // 内部で非同期のセマフォを待機するため、この関数自体は Promise を返す runLlmProcessSync の結果を待機する。
  // ただし、SpawnSyncFn のシグネチャが同期的である必要がある場合は注意。
  // 元のコードでは await lockFn(...) の中で spawnSync を呼んでいるので、非同期化しても問題ないはず。
  return runLlmProcessSync(
    command,
    args as string[],
    options as SpawnSyncOptionsWithStringEncoding,
  ) as unknown as SpawnSyncResult;
};

// deps.withLock は不要になる（runLlmProcessSync が内部でロックするため）
const defaultLock = <T>(name: string, fn: () => Promise<T>) => fn();

/**
 * ローカル LLM を使用してテキストからエンティティ情報を抽出します。
 */
export async function extractEntitiesFromText(
  text: string,
  deps: LlmServiceDeps = {},
): Promise<ExtractedEntity[]> {
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const llmScript = deps.llmScript ?? config.llmScript;
  const llmTimeoutMs = deps.llmTimeoutMs ?? config.llmTimeoutMs;
  const lockFn = deps.withLock ?? defaultLock;
  const prompt = `
以下のテキストから、将来の作業で再利用できる主要な知識を抽出してください。
出力は必ず以下のJSON配列形式のみで返してください。余計な解説は不要です。

[
  {
    "name": "実体名（公式名稱、日本語可）",
    "type": "以下から1つ選択: rule|procedure|skill|decision|lesson|observation|risk|command_recipe|reference|project_doc|task|goal|constraint|context|project|library|service|tool|concept|person|pattern|config",
    "description": "50文字以上の説明。何であるか、なぜ重要かを含む。短すぎる説明は不可"
  }
]

テキスト:
"${text}"
`.trim();

  try {
    const result = await lockFn('llm-pool', async () =>
      spawnSync(llmScript, ['--output', 'text', '--prompt', prompt], {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout:
          Number.isFinite(llmTimeoutMs) && llmTimeoutMs > 0
            ? llmTimeoutMs
            : config.llm.defaultTimeoutMs,
      }),
    );

    if (result.error) {
      console.error('LLM Extraction Error:', result.error);
      return [];
    }

    if (result.status !== 0) {
      console.error(
        'LLM Extraction failed:',
        result.stderr?.trim() || `exit code ${result.status}`,
      );
      return [];
    }

    const output = result.stdout?.trim();
    if (!output) return [];

    const parsed = JSON.parse(output);
    return ExtractedEntitySchema.array().parse(parsed);
  } catch (error) {
    console.error('Failed to extract entities from text using LLM:', error);
    return [];
  }
}

/**
 * コミュニティに属する情報を要約します
 */
export async function summarizeCommunity(
  context: string,
  deps: LlmServiceDeps = {},
): Promise<{ name: string; summary: string }> {
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const llmScript = deps.llmScript ?? config.llmScript;
  const llmTimeoutMs = deps.llmTimeoutMs ?? config.llmTimeoutMs;
  const lockFn = deps.withLock ?? defaultLock;
  const prompt = `
以下のナレッジグラフ断片（エンティティと関係性）を読み取り、この知識の塊が「何に関するものか」を要約してください。
JSON整形は不要です。自然言語のテキストで出力してください。

出力形式（プレーンテキスト、2行のみ）:
1行目: この知識群を表す短い名前だけ
2行目: このコミュニティが含む主要トピックや関係性の概要だけ（100文字程度）

対象データ:
"""
${context}
"""
`.trim();

  try {
    const result = await lockFn('llm-pool', async () =>
      spawnSync(llmScript, ['--output', 'text', '--max-tokens', '512', '--prompt', prompt], {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout:
          Number.isFinite(llmTimeoutMs) && llmTimeoutMs > 0
            ? llmTimeoutMs
            : config.llm.defaultTimeoutMs,
      }),
    );

    const output = result.stdout?.trim();
    if (!output) {
      if (result.error) console.error('LLM Summary Error:', result.error);
      throw new Error('Empty LLM response');
    }

    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 2) {
      return {
        name: lines[0] ?? 'Unknown Community',
        summary: lines[1] ?? '要約の生成に失敗しました。',
      };
    }
    throw new Error('Community summary output did not match the two-line contract.');
  } catch (error) {
    console.error('Failed to summarize community:', error);
    return { name: 'Unknown Community', summary: '要約の生成に失敗しました。' };
  }
}

const CommunitySummarySchema = z.object({
  name: z.string().min(1),
  summary: z.string().min(1),
});

function normalizeDistilledKnowledge(raw: unknown): DistilledKnowledge {
  return DistilledKnowledgeSchema.parse(raw);
}

const truncateLogText = (value: string, max = 400): string => {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
};

const parseDistillationFromText = (text: string): DistilledKnowledge => {
  const memories = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return normalizeDistilledKnowledge({
    memories: memories.slice(0, 20),
    entities: [],
    relations: [],
  });
};

/**
 * 会話記録から重要な知識を要約・抽出します。
 */
export async function distillKnowledgeFromTranscript(
  transcript: string,
  deps: LlmServiceDeps = {},
): Promise<DistilledKnowledge> {
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const llmScript = deps.llmScript;
  const llmTimeoutMs = deps.llmTimeoutMs ?? config.llmTimeoutMs;
  const lockFn = deps.withLock ?? defaultLock;
  const prompt = `
以下のAIエージェントとの会話記録（JSONLパース済みテキスト）を分析し、
将来の参照に役立つ再利用可能な知識だけを抽出してください。

【厳守事項】
1. パスワード、APIキー、認証トークン、個人情報（住所・電話番号等）は絶対に抽出しないでください。
2. 雑談や一時的な挨拶、重要度の低い試行錯誤は無視してください。
3. 単なるタスク開始・終了・進捗ログは抽出しないでください。
4. ユーザーの明示的な方針、成功した手順、失敗から得た教訓、運用上の注意、プロジェクト固有ルールを優先してください。
5. type は原則として rule|procedure|skill|decision|lesson|observation|risk|command_recipe|reference|project_doc から選択してください。旧来の task|goal|constraint|context|project|library|service|tool|concept|person|pattern|config は対象が再利用ナレッジでない場合の補助分類に限ります。
6. JSONの整形は不要です。自然言語のテキストで出力してください。
7. 箇条書き中心の自然文で、再利用可能な知識のみを書いてください。

会話記録:
"""
${transcript}
"""
`.trim();

  let output = '';
  const startedAt = Date.now();
  console.info(
    `[SynthesisDistill] start transcriptChars=${transcript.length} promptChars=${prompt.length}`,
  );

  try {
    const routed = await runPromptWithMemoryLoopRouter(
      {
        prompt,
        taskKind: 'distillation',
        llmScript,
        llmTimeoutMs:
          Number.isFinite(llmTimeoutMs) && llmTimeoutMs > 0
            ? llmTimeoutMs
            : config.llm.defaultTimeoutMs * 2,
        maxTokens: 1500,
      },
      {
        spawnSync,
        withLock: lockFn,
      },
    );
    output = routed.output;
    console.info(
      `[SynthesisDistill] route alias=${routed.route.alias} attempts=${routed.attempts} cloud=${routed.route.cloudEnabledForAttempt} reason=${routed.route.reason} outputChars=${output.length}`,
    );
  } catch (error) {
    console.error(
      `[SynthesisDistill] route_error elapsedMs=${Date.now() - startedAt} message=${truncateLogText(
        error instanceof Error ? error.message : String(error),
        600,
      )}`,
    );
    throw new Error('LLM distillation command failed');
  }

  if (!output) {
    console.error(
      `[SynthesisDistill] empty_output elapsedMs=${Date.now() - startedAt} transcriptChars=${
        transcript.length
      }`,
    );
    throw new Error('Empty LLM response');
  }

  try {
    const normalized = parseDistillationFromText(output);
    console.info(
      `[SynthesisDistill] parsed_ok elapsedMs=${Date.now() - startedAt} memories=${
        normalized.memories.length
      } entities=${normalized.entities.length} relations=${normalized.relations.length}`,
    );
    return normalized;
  } catch (error) {
    console.error(
      `[SynthesisDistill] parse_error elapsedMs=${
        Date.now() - startedAt
      } outputPreview="${truncateLogText(output)}" message=${truncateLogText(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
    throw error;
  }
}

/**
 * 2つのエンティティが同一の実体を指しているか判定し、同一であればマージした情報を返します。
 */
export async function judgeAndMergeEntities(
  entityA: { name: string; type: string; description: string },
  entityB: { name: string; type: string; description: string },
  deps: LlmServiceDeps = {},
): Promise<MergedEntityResult> {
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const llmScript = deps.llmScript ?? config.llmScript;
  const llmTimeoutMs = deps.llmTimeoutMs ?? config.llmTimeoutMs;
  const lockFn = deps.withLock ?? defaultLock;
  const prompt = `
以下の2つのエンティティ（実体）が、同じ対象を指しているか判定してください。
名前の揺らぎ（別名、略称、英語表記とカタカナ表記等）があっても、文脈上同じであれば merge と判定してください。
別物である場合は separate と判定してください。

出力は次のどちらか1語のみ:
merge
separate

対象1:
- 名前: ${entityA.name}
- 種別: ${entityA.type}
- 説明: ${entityA.description}

対象2:
- 名前: ${entityB.name}
- 種別: ${entityB.type}
- 説明: ${entityB.description}
`.trim();

  try {
    const result = await lockFn('llm-pool', async () =>
      spawnSync(llmScript, ['--output', 'text', '--max-tokens', '800', '--prompt', prompt], {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout: llmTimeoutMs,
      }),
    );

    const output = result.stdout?.trim();
    if (!output) return { shouldMerge: false };

    const decision = output.toLowerCase();
    if (decision !== 'merge') return { shouldMerge: false };

    return MergedEntityResultSchema.parse({
      shouldMerge: true,
      merged: {
        name: entityB.name,
        type: entityB.type,
        description: [entityB.description, entityA.description]
          .map((item) => item.trim())
          .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index)
          .join('\n'),
      },
    });
  } catch (error) {
    console.error('Failed to judge and merge entities:', error);
  }

  return { shouldMerge: false };
}
