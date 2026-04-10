import { spawnSync } from 'node:child_process';

const LLM_SCRIPT =
  process.env.GNOSIS_ENTITY_LLM_SCRIPT || '/Users/y.noguchi/Code/localLlm/scripts/gemma4';
const LLM_TIMEOUT_MS = Number(process.env.GNOSIS_ENTITY_LLM_TIMEOUT_MS || '45000');

export interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
}

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
    const result = spawnSync(LLM_SCRIPT, ['--output', 'text', '--prompt', prompt], {
      encoding: 'utf-8',
      env: { ...process.env },
      timeout: Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0 ? LLM_TIMEOUT_MS : 45000,
    });

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
    if (!Array.isArray(parsed)) return [];

    const entities = parsed
      .filter(
        (item): item is ExtractedEntity =>
          item &&
          typeof item === 'object' &&
          typeof (item as ExtractedEntity).name === 'string' &&
          typeof (item as ExtractedEntity).type === 'string' &&
          typeof (item as ExtractedEntity).description === 'string',
      )
      .map((item) => ({
        name: item.name.trim(),
        type: item.type.trim(),
        description: item.description.trim(),
      }))
      .filter(
        (item) => item.name.length > 0 && item.type.length > 0 && item.description.length > 0,
      );

    return entities;
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
    const result = spawnSync(
      LLM_SCRIPT,
      ['--output', 'text', '--max-tokens', '512', '--prompt', prompt],
      {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout: Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0 ? LLM_TIMEOUT_MS : 45000,
      },
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

export interface DistilledKnowledge {
  memories: string[];
  entities: { id: string; type: string; name: string; description: string }[];
  relations: { sourceId: string; targetId: string; relationType: string; weight: number }[];
}

function normalizeDistilledKnowledge(raw: unknown): DistilledKnowledge {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid distilled payload');
  }

  const payload = raw as Record<string, unknown>;

  const memories = Array.isArray(payload.memories)
    ? payload.memories.filter((memory): memory is string => typeof memory === 'string')
    : [];

  const entities = Array.isArray(payload.entities)
    ? payload.entities.filter(
        (entity): entity is DistilledKnowledge['entities'][number] =>
          entity !== null &&
          typeof entity === 'object' &&
          typeof entity.id === 'string' &&
          typeof entity.type === 'string' &&
          typeof entity.name === 'string' &&
          typeof entity.description === 'string',
      )
    : [];

  const relations = Array.isArray(payload.relations)
    ? payload.relations
        .filter(
          (
            relation,
          ): relation is {
            sourceId: string;
            targetId: string;
            relationType: string;
            weight: number | string;
          } =>
            relation !== null &&
            typeof relation === 'object' &&
            typeof (relation as { sourceId?: unknown }).sourceId === 'string' &&
            typeof (relation as { targetId?: unknown }).targetId === 'string' &&
            typeof (relation as { relationType?: unknown }).relationType === 'string' &&
            (typeof (relation as { weight?: unknown }).weight === 'number' ||
              typeof (relation as { weight?: unknown }).weight === 'string'),
        )
        .map((relation) => ({
          sourceId: relation.sourceId,
          targetId: relation.targetId,
          relationType: relation.relationType,
          weight: typeof relation.weight === 'number' ? relation.weight : Number(relation.weight),
        }))
        .filter((relation) => Number.isFinite(relation.weight))
    : [];

  return { memories, entities, relations };
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

  const result = spawnSync(
    LLM_SCRIPT,
    ['--output', 'text', '--max-tokens', '1500', '--prompt', prompt],
    {
      encoding: 'utf-8',
      env: { ...process.env },
      timeout: Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0 ? LLM_TIMEOUT_MS : 90000,
    },
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
