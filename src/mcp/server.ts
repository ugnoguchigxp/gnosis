import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createLocalLlmRetriever } from '../adapters/retriever/mcpRetriever.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { buildCommunities } from '../services/community.js';
import { recallExperienceLessons, saveExperience } from '../services/experience.js';
import {
  deleteRelation,
  digestTextIntelligence,
  findEntityById,
  findPathBetweenEntities,
  queryGraphContext,
  saveEntities,
  saveRelations,
  searchEntityByQuery,
  updateEntity,
} from '../services/graph.js';
import { saveGuidance } from '../services/guidance.js';
import { PgKnowledgeRepository } from '../services/knowflow/knowledge/repository.js';
import { PgJsonbQueueRepository } from '../services/knowflow/queue/pgJsonbRepository.js';
import {
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from '../services/knowflow/worker/knowFlowHandler.js';
import { runWorkerOnce } from '../services/knowflow/worker/loop.js';
import { getKnowledgeByTopic, searchKnowledgeClaims } from '../services/knowledge.js';
import { deleteMemory, saveMemory, searchMemory } from '../services/memory.js';
import { syncAllAgentLogs } from '../services/sync.js';
import { synthesizeKnowledge } from '../services/synthesis.js';

export const server = new Server(
  {
    name: 'gnosis-memory-kg',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tools Definition Schema
const storeMemorySchema = z.object({
  sessionId: z.string().describe('セッションID (プロジェクトやコンテキストを分離する識別子)'),
  content: z.string().describe('記憶するテキスト内容'),
  metadata: z.record(z.unknown()).optional().describe('その他のメタデータ'),
  entities: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        name: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional()
    .describe('関連するエンティティ(抽出された場合)'),
  relations: z
    .array(
      z.object({
        sourceId: z.string(),
        targetId: z.string(),
        relationType: z.string(),
        weight: z.union([z.number(), z.string()]).optional(),
      }),
    )
    .optional()
    .describe('エンティティ間の関係'),
});

const searchMemorySchema = z.object({
  sessionId: z.string().describe('検索対象のセッションID'),
  query: z.string().describe('検索クエリ'),
  limit: z.number().optional().default(5).describe('取得件数'),
  filter: z.record(z.unknown()).optional().describe('メタデータのJSONフィルタ条件'),
});

const queryGraphSchema = z.object({
  query: z
    .string()
    .describe('起点とするエンティティを探すための検索クエリ(IDあるいは名前・説明など)'),
});

const digestTextSchema = z.object({
  text: z.string().describe('既存の知識グラフとの関連を調査したいテキスト'),
  limit: z.number().optional().default(5).describe('提案するエンティティの最大数'),
});

const deleteMemorySchema = z.object({
  memoryId: z.string().describe('削除する Vibe Memory の ID'),
});

const updateGraphSchema = z.object({
  action: z.enum(['update_entity', 'delete_relation']).describe('実行する更新のタイプ'),
  entity: z
    .object({
      id: z.string(),
      type: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
    })
    .optional()
    .describe('エンティティ情報の更新時のみ使用'),
  relation: z
    .object({
      sourceId: z.string(),
      targetId: z.string(),
      relationType: z.string(),
    })
    .optional()
    .describe('リレーション削除時のみ使用'),
});

const recordExperienceSchema = z.object({
  sessionId: z.string().describe('セッションID'),
  scenarioId: z.string().describe('シナリオID (e.g., smoke-001)'),
  attempt: z.number().int().positive().describe('試行回数'),
  type: z.enum(['failure', 'success']).describe('イベントのタイプ (failure or success)'),
  content: z.string().describe('イベントの内容 (失敗メッセージや成功パッチの説明)'),
  failureType: z.string().optional().describe('失敗のタイプ (e.g., RISK_BLOCKING)'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe('追加のメタデータ (riskFindings, applyRejects, patchDigest など)'),
});

const recallLessonsSchema = z.object({
  sessionId: z.string().describe('検索対象のセッションID'),
  query: z.string().describe('現在の失敗状況やエラーメッセージ'),
  limit: z.number().int().positive().optional().default(5).describe('取得件数'),
});

const searchKnowledgeSchema = z.object({
  query: z.string().describe('検索クエリ'),
  limit: z.number().int().positive().optional().default(5).describe('取得件数'),
});

const getKnowledgeSchema = z.object({
  topic: z.string().describe('詳細を取得したいトピック名'),
});

const enqueueKnowledgeTaskSchema = z.object({
  topic: z.string().describe('調査を開始するトピック名'),
  mode: z
    .enum(['directed', 'expand', 'explore'])
    .optional()
    .default('directed')
    .describe('調査モード'),
  priority: z
    .number()
    .optional()
    .default(config.guidance.priorityLow)
    .describe('優先度 (高いほど先に実行)'),
});

const runKnowledgeWorkerSchema = z.object({
  maxAttempts: z.number().optional().default(1).describe('最大試行回数'),
});
const searchUnifiedSchema = z.object({
  query: z.string().describe('検索クエリ'),
  mode: z.enum(['fts', 'kg', 'semantic']).describe('検索モード'),
  limit: z.number().int().positive().optional().default(5).describe('取得件数'),
  sessionId: z
    .string()
    .optional()
    .describe('semantic モード使用時のセッションID (デフォルト: gnosis)'),
});

const registerGuidanceSchema = z.object({
  title: z.string().describe('ガイダンスのタイトル'),
  content: z.string().describe('内容（マークダウン形式推奨）'),
  guidanceType: z
    .enum(['rule', 'skill'])
    .describe('種別 (rule: 規約・禁止事項, skill: 手順・ノウハウ)'),
  scope: z
    .enum(['always', 'on_demand'])
    .describe('適用範囲 (always: 常に参照, on_demand: 必要時のみ検索)'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .default(config.guidance.priorityLow)
    .describe('優先度 (0-100)'),
  tags: z.array(z.string()).optional().describe('関連タグ'),
  archiveKey: z.string().optional().describe('管理用キー (省略時はタイトルから自動生成)'),
  sessionId: z.string().optional().describe('セッションID (デフォルト: config.guidance.sessionId)'),
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'store_memory',
        description: `汎用的な観察・知識・レビュー結果を Vibe Memory（ベクトル検索）と Knowledge Graph に保存します。
- コードレビューの指摘事項・改善提案を後で参照できるよう保存する
- 設計上の決定・トレードオフの記録
- バグの原因分析、調査結果のメモ
- 任意の自由形式の観察・知見の蓄積`,
        inputSchema: zodToJsonSchema(storeMemorySchema),
      },
      {
        name: 'search_memory',
        description: `保存済みの Vibe Memory をセマンティック（意味的類似度）で検索します。
メタデータフィルタと組み合わせたハイブリッド検索も可能です。`,
        inputSchema: zodToJsonSchema(searchMemorySchema),
      },
      {
        name: 'query_graph',
        description: `Knowledge Graph からエンティティとその関連情報を取得します（Graph RAG）。
指定エンティティを起点に最大2ホップ先の関連ノード・エッジを一括取得します。`,
        inputSchema: zodToJsonSchema(queryGraphSchema),
      },
      {
        name: 'digest_text',
        description:
          'テキスト中のキーワードに関連する既存グラフエンティティを検索し、候補を提案します。',
        inputSchema: zodToJsonSchema(digestTextSchema),
      },
      {
        name: 'delete_memory',
        description: '特定の Vibe Memory を ID を指定して削除します（忘却操作）。',
        inputSchema: zodToJsonSchema(deleteMemorySchema),
      },
      {
        name: 'build_communities',
        description: 'グラフ全体を分析し、知識の塊（コミュニティ）を検出・要約します。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'sync_agent_logs',
        description:
          'Claude Code や Cursor Agent などの会話履歴を解析し、ナレッジを Gnosis に一括同期します。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'update_graph',
        description:
          'グラフ内のエンティティ情報を修正、またはリレーションを削除してナレッジを正確に保ちます。',
        inputSchema: zodToJsonSchema(updateGraphSchema),
      },
      {
        name: 'find_path',
        description: '2つのエンティティ間の最短経路（つながり）を Knowledge Graph から探索します。',
        inputSchema: zodToJsonSchema(
          z.object({
            queryA: z.string().describe('起点エンティティ（ID、名前、または説明文）'),
            queryB: z.string().describe('終点エンティティ（ID、名前、または説明文）'),
          }),
        ),
      },
      {
        name: 'reflect_on_memories',
        description:
          '未処理の Vibe Memory を分析し、エンティティと関係性を自動抽出して Knowledge Graph に統合します（自己省察）。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'record_experience',
        description:
          'llmharness のシナリオ実行で生じた失敗・成功イベントを、構造化された教訓として記録します。',
        inputSchema: zodToJsonSchema(recordExperienceSchema),
      },
      {
        name: 'recall_lessons',
        description:
          'llmharness のパイプライン実行中に失敗した際、過去の類似失敗から解決策・教訓を検索します。',
        inputSchema: zodToJsonSchema(recallLessonsSchema),
      },
      {
        name: 'search_knowledge',
        description: `knowFlow が蓄積した構造化知識（knowledge_claims）を全文検索します。
登録済みクレームのみを対象に、FTS スコア順で返します。`,
        inputSchema: zodToJsonSchema(searchKnowledgeSchema),
      },
      {
        name: 'get_knowledge',
        description:
          '特定のトピックについて、knowFlow が収集・検証した詳細な知識（クレーム、関連トピック、情報源）をすべて取得します。',
        inputSchema: zodToJsonSchema(getKnowledgeSchema),
      },
      {
        name: 'enqueue_knowledge_task',
        description: `特定のトピックについて knowFlow に調査・知識化タスクを依頼します（非同期処理）。
バックグラウンドまたは run_knowledge_worker によって処理されます。`,
        inputSchema: zodToJsonSchema(enqueueKnowledgeTaskSchema),
      },
      {
        name: 'run_knowledge_worker',
        description: `キューに溜まっている KnowFlow タスクを1つ取り出して実行します。
ウェブ検索や LLM による解析を伴うため、完了まで時間がかかる場合があります。`,
        inputSchema: zodToJsonSchema(runKnowledgeWorkerSchema),
      },
      {
        name: 'search_unified',
        description: `目的や対象に応じた最適な手法（全文検索・グラフ・意味検索）を選択して検索を実行します。
- fts: knowFlow が蓄積した検証済み知識の全文検索
- kg: ナレッジグラフ内のエンティティとそのつながりの探索
- semantic: 保存済みの記憶（Vibe Memory）の意味的類似度検索`,
        inputSchema: zodToJsonSchema(searchUnifiedSchema),
      },
      {
        name: 'register_guidance',
        description:
          '新しいルールやスキルを Gnosis Guidance Registry に登録します。登録された内容は AI アシスタントへの指示（プロンプト）に自動挿入されるようになります。',
        inputSchema: zodToJsonSchema(registerGuidanceSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'store_memory': {
        const input = storeMemorySchema.parse(args);

        const memory = await db.transaction(async (tx) => {
          // メモリ保存
          const savedMemory = await saveMemory(input.sessionId, input.content, input.metadata, tx);

          // グラフ保存
          if (input.entities?.length) await saveEntities(input.entities, tx);
          if (input.relations?.length) await saveRelations(input.relations, tx);
          return savedMemory;
        });

        return {
          content: [{ type: 'text', text: `Memory stored successfully with ID: ${memory.id}` }],
        };
      }

      case 'search_memory': {
        const { sessionId, query, limit, filter } = searchMemorySchema.parse(args);
        const results = await searchMemory(sessionId, query, limit, filter);

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }

      case 'delete_memory': {
        const { memoryId } = deleteMemorySchema.parse(args);
        await deleteMemory(memoryId);

        return {
          content: [{ type: 'text', text: `Memory ${memoryId} has been deleted successfully` }],
        };
      }

      case 'query_graph': {
        const { query } = queryGraphSchema.parse(args);
        const exactMatchId = await findEntityById(query);
        const entityId = exactMatchId || (await searchEntityByQuery(query));
        if (!entityId) {
          return {
            content: [{ type: 'text', text: `No entity found matching query: ${query}` }],
          };
        }

        const context = await queryGraphContext(entityId); // Default depth is 2, max 20 nodes

        return {
          content: [{ type: 'text', text: JSON.stringify(context, null, 2) }],
        };
      }

      case 'digest_text': {
        const { text, limit } = digestTextSchema.parse(args);
        const results = await digestTextIntelligence(text, limit);

        return {
          content: [
            {
              type: 'text',
              text: 'LLM has extracted the following entities and found potential matches in the existing graph:',
            },
            { type: 'text', text: JSON.stringify(results, null, 2) },
          ],
        };
      }

      case 'update_graph': {
        const input = updateGraphSchema.parse(args);
        if (input.action === 'update_entity') {
          if (!input.entity?.id) throw new Error('entity.id is required for update_entity');
          await updateEntity(input.entity.id, input.entity);
          return {
            content: [{ type: 'text', text: `Entity ${input.entity.id} updated successfully` }],
          };
        }
        if (input.action === 'delete_relation') {
          if (!input.relation) throw new Error('relation info is required for delete_relation');
          await deleteRelation(
            input.relation.sourceId,
            input.relation.targetId,
            input.relation.relationType,
          );
          return {
            content: [
              {
                type: 'text',
                text: `Relation ${input.relation.relationType} deleted successfully`,
              },
            ],
          };
        }
        throw new Error(`Unsupported action: ${input.action}`);
      }

      case 'build_communities': {
        const result = await buildCommunities();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'sync_agent_logs': {
        const result = await syncAllAgentLogs();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'find_path': {
        const { queryA, queryB } = z.object({ queryA: z.string(), queryB: z.string() }).parse(args);
        const result = await findPathBetweenEntities(queryA, queryB);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'reflect_on_memories': {
        const result = await synthesizeKnowledge();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'record_experience': {
        const input = recordExperienceSchema.parse(args);
        const experience = await saveExperience(input);
        return {
          content: [
            {
              type: 'text',
              text: `Experience recorded successfully with ID: ${experience.id}`,
            },
          ],
        };
      }

      case 'recall_lessons': {
        const { sessionId, query, limit } = recallLessonsSchema.parse(args);
        const results = await recallExperienceLessons(sessionId, query, limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }

      case 'search_knowledge': {
        const { query, limit } = searchKnowledgeSchema.parse(args);
        const results = await searchKnowledgeClaims(query, limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }

      case 'get_knowledge': {
        const { topic } = getKnowledgeSchema.parse(args);
        const result = await getKnowledgeByTopic(topic);
        return {
          content: [
            {
              type: 'text',
              text: result
                ? JSON.stringify(result, null, 2)
                : `No detailed knowledge found for topic: ${topic}`,
            },
          ],
        };
      }

      case 'enqueue_knowledge_task': {
        const input = enqueueKnowledgeTaskSchema.parse(args);
        const repository = new PgJsonbQueueRepository();
        const result = await repository.enqueue({
          topic: input.topic,
          mode: input.mode,
          source: 'user',
          priority: input.priority,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Task enqueued successfully. taskId: ${result.task.id}, deduped: ${result.deduped}`,
            },
          ],
        };
      }

      case 'run_knowledge_worker': {
        const { maxAttempts } = runKnowledgeWorkerSchema.parse(args);
        const queueRepo = new PgJsonbQueueRepository();
        const knowledgeRepo = new PgKnowledgeRepository();
        const retriever = createLocalLlmRetriever(config.localLlmPath);
        const evidenceProvider = createMcpEvidenceProvider(retriever);

        const handler = createKnowFlowTaskHandler({
          repository: knowledgeRepo,
          evidenceProvider,
        });

        const result = await runWorkerOnce(queueRepo, handler, {
          maxAttempts,
        });

        return {
          content: [
            {
              type: 'text',
              text: result.processed
                ? `Task processed: ${result.taskId}, status: ${result.status}`
                : 'No pending tasks in queue.',
            },
          ],
        };
      }

      case 'search_unified': {
        const { query, mode, limit, sessionId } = searchUnifiedSchema.parse(args);

        if (mode === 'fts') {
          const results = await searchKnowledgeClaims(query, limit);
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          };
        }

        if (mode === 'kg') {
          const exactMatchId = await findEntityById(query);
          const entityId = exactMatchId || (await searchEntityByQuery(query));
          if (!entityId) {
            return {
              content: [
                { type: 'text', text: `No entity found in graph matching query: ${query}` },
              ],
            };
          }
          const context = await queryGraphContext(entityId);
          return {
            content: [{ type: 'text', text: JSON.stringify(context, null, 2) }],
          };
        }

        if (mode === 'semantic') {
          const results = await searchMemory(sessionId || 'gnosis', query, limit);
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          };
        }

        throw new Error(`Unsupported search mode: ${mode}`);
      }

      case 'register_guidance': {
        const input = registerGuidanceSchema.parse(args);
        const result = await saveGuidance(input);
        return {
          content: [
            {
              type: 'text',
              text: `Guidance registered successfully: ${input.title} (archiveKey: ${result.archiveKey})`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error executing tool: ${message}` }],
      isError: true,
    };
  }
});
