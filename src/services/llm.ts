import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { config } from '../config.js';
import { withGlobalLock } from '../utils/lock.js';

const LLM_SCRIPT = config.llmScript;
const LLM_TIMEOUT_MS = config.llmTimeoutMs;

import {
  DistilledKnowledgeSchema,
  ExtractedEntitySchema,
  MergedEntityResultSchema,
} from '../domain/schemas.js';
import type { DistilledKnowledge, ExtractedEntity, MergedEntityResult } from '../domain/schemas.js';

/**
 * ローカル LLM を使用してテキストからエンティティ情報を抽出します。
 */
export async function extractEntitiesFromText(text: string): Promise<ExtractedEntity[]> {
  const prompt = `
以下のテキストから、主要なエンティティ（実体）を抽出してください。
出力は必ず以下のJSON配列形式のみで返してください。余計な解説は不要です。

[
  { "name": "実体名", "type": "種別(Person/City/Concept等)", "description": "短い説明" }
]

テキスト:
"${text}"
`.trim();

  try {
    const result = await withGlobalLock('local-llm', async () =>
      spawnSync(LLM_SCRIPT, ['--output', 'text', '--prompt', prompt], {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout:
          Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0
            ? LLM_TIMEOUT_MS
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

    // JSON 部分のみを抽出（念のため）
    const jsonMatch = output.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!jsonMatch) {
      console.warn('Failed to find JSON in LLM response:', output);
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
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
): Promise<{ name: string; summary: string }> {
  const prompt = `
以下のナレッジグラフ断片（エンティティと関係性）を読み取り、この知識の塊が「何に関するものか」を要約してください。
出力は必ず以下のJSON形式のみで返してください。

{ "name": "この知識群を表す短い名前(例: 日本の地理)", "summary": "このコミュニティが含む主要なトピックや関係性の概要(100文字程度)" }

対象データ:
"""
${context}
"""
`.trim();

  try {
    const result = await withGlobalLock('local-llm', async () =>
      spawnSync(LLM_SCRIPT, ['--output', 'text', '--max-tokens', '512', '--prompt', prompt], {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout:
          Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0
            ? LLM_TIMEOUT_MS
            : config.llm.defaultTimeoutMs,
      }),
    );

    const output = result.stdout?.trim();
    if (!output) {
      if (result.error) console.error('LLM Summary Error:', result.error);
      throw new Error('Empty LLM response');
    }

    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');

    return JSON.parse(jsonMatch[0]);
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

/**
 * 会話記録から重要な知識を要約・抽出します。
 */
export async function distillKnowledgeFromTranscript(
  transcript: string,
): Promise<DistilledKnowledge> {
  const prompt = `
以下のAIエージェントとの会話記録（JSONLパース済みテキスト）を分析し、
将来の参照に役立つ「重要な事実」「技術的決定」「プロジェクト構造」などを抽出してください。

【厳守事項】
1. パスワード、APIキー、認証トークン、個人情報（住所・電話番号等）は絶対に抽出しないでください。
2. 雑談や一時的な挨拶、重要度の低い試行錯誤は無視してください。
3. 出力は必ず以下のJSON形式のみで返してください。

{
  "memories": ["短い文章形式の記憶1", "記憶2"],
  "entities": [{ "id": "唯一のID", "type": "種別", "name": "名前", "description": "説明" }],
  "relations": [{ "sourceId": "ID1", "targetId": "ID2", "relationType": "関係名", "weight": 1.0 }]
}

会話記録:
"""
${transcript}
"""
`.trim();

  const result = await withGlobalLock('local-llm', async () =>
    spawnSync(LLM_SCRIPT, ['--output', 'text', '--max-tokens', '1500', '--prompt', prompt], {
      encoding: 'utf-8',
      env: { ...process.env },
      timeout:
        Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0
          ? LLM_TIMEOUT_MS
          : config.llm.defaultTimeoutMs * 2,
    }),
  );

  if (result.error) {
    console.error('LLM Distillation Error:', result.error);
    throw new Error('LLM distillation command failed');
  }

  if (result.status !== 0) {
    console.error('LLM Distillation Status:', result.status);
    console.error('LLM Distillation Stderr:', result.stderr?.trim());
    throw new Error(`LLM distillation exited with status ${result.status}`);
  }

  const output = result.stdout?.trim();
  if (!output) {
    throw new Error('Empty LLM response');
  }

  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('LLM Distillation raw output:', output);
    throw new Error('No JSON found in LLM response');
  }

  let jsonStr = jsonMatch[0];
  // トレイリングカンマなどの一般的なJSONエラーを簡易除去
  jsonStr = jsonStr.replace(/,\s*([\}\]])/g, '$1');

  try {
    const parsed = JSON.parse(jsonStr);
    return normalizeDistilledKnowledge(parsed);
  } catch (error) {
    console.error('Failed to parse distilled JSON:', jsonStr);
    throw error;
  }
}

/**
 * 2つのエンティティが同一の実体を指しているか判定し、同一であればマージした情報を返します。
 */
export async function judgeAndMergeEntities(
  entityA: { name: string; type: string; description: string },
  entityB: { name: string; type: string; description: string },
): Promise<MergedEntityResult> {
  const prompt = `
以下の2つのエンティティ（実体）が、同じ対象を指しているか判定してください。
名前の揺らぎ（別名、略称、英語表記とカタカナ表記等）があっても、文脈上同じであれば「同一」とみなしてください。

同一である場合は shouldMerge: true とし、2つの情報を統合した最適な name, type, description を出力してください。
別物である場合は shouldMerge: false としてください。

出力は必ず以下のJSON形式のみで返してください。余計な解説は不要です。

{
  "shouldMerge": true/false,
  "merged": { "name": "統合後の名前", "type": "種別", "description": "統合された説明" }
}

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
    const result = await withGlobalLock('local-llm', async () =>
      spawnSync(LLM_SCRIPT, ['--output', 'text', '--max-tokens', '800', '--prompt', prompt], {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout: LLM_TIMEOUT_MS,
      }),
    );

    const output = result.stdout?.trim();
    if (!output) return { shouldMerge: false };

    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { shouldMerge: false };

    const parsed = JSON.parse(jsonMatch[0].replace(/,\s*([\}\]])/g, '$1'));
    return MergedEntityResultSchema.parse(parsed);
  } catch (error) {
    console.error('Failed to judge and merge entities:', error);
  }

  return { shouldMerge: false };
}
