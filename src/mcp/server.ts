import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
  filter: z.record(z.any()).optional().describe('メタデータのJSONフィルタ条件'),
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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'store_memory',
        description: `汎用的な観察・知識・レビュー結果を Vibe Memory（ベクトル検索）と Knowledge Graph に保存します。

【使うべき場面】
- コードレビューの指摘事項・改善提案を後で参照できるよう保存する
- 設計上の決定・トレードオフの記録
- バグの原因分析、調査結果のメモ
- 任意の自由形式の観察・知見の蓄積

【使ってはいけない場面】
- llmharness のシナリオ実行で生じた失敗・成功イベントの記録 → record_experience を使う

【sessionId の命名規則】
- コードレビュー結果: "<プロジェクト名>-reviews"  例: "llmharness-reviews"
- 設計メモ・調査結果: "<プロジェクト名>-notes"    例: "llmharness-notes"
- 成功パッチの記録:   "<プロジェクト名>-verified" 例: "llmharness-verified"

【entities / relations の活用】
省略可能ですが、関連するクラス名・関数名・ファイルパスを entities に含めると
query_graph での関係性探索が可能になります。`,
        inputSchema: zodToJsonSchema(storeMemorySchema),
      },
      {
        name: 'search_memory',
        description: `保存済みの Vibe Memory をセマンティック（意味的類似度）で検索します。
メタデータフィルタと組み合わせたハイブリッド検索も可能です。

【使うべき場面】
- 過去のコードレビュー指摘を特定ファイルやトピックで検索する
- 設計メモ・調査結果を意味的に近いクエリで検索する
- 保存した任意のメモをフリーテキストで探す

【使ってはいけない場面】
- llmharness パイプラインの失敗から解決策を探す → recall_lessons を使う
- 特定エンティティの関係性を辿る → query_graph を使う

【sessionId の指定】
検索対象のセッションIDを正確に指定してください。
例: "llmharness-reviews"（レビュー結果）、"llmharness-notes"（設計メモ）

【filter の使い方例】
{ "file": "src/adapters/localllm.ts" }  → 特定ファイルへの指摘のみ絞り込み
{ "severity": "error" }                 → 重大な指摘のみ`,
        inputSchema: zodToJsonSchema(searchMemorySchema),
      },
      {
        name: 'query_graph',
        description: `Knowledge Graph からエンティティとその関連情報を取得します（Graph RAG）。
指定エンティティを起点に最大2ホップ先の関連ノード・エッジを一括取得します。

【使うべき場面】
- 「このクラス/関数/モジュールがどのコンポーネントと関係しているか」を調べる
- 特定のバグ・パターンに関連する過去の知識を構造的に取得する
- エンティティ間の依存関係・影響範囲を把握する

【使ってはいけない場面】
- テキストの意味的類似で記憶を探す → search_memory を使う
- エンティティ名が不明で探索的に探す → digest_text で候補を調べてからこのツールへ

【query の指定方法】
エンティティのID、名前、説明文いずれでも検索できます。
例: "src/adapters/localllm.ts"、"reviewCode"、"null check pattern"`,
        inputSchema: zodToJsonSchema(queryGraphSchema),
      },
      {
        name: 'digest_text',
        description: `テキスト中のキーワードに関連する既存グラフエンティティを検索し、候補を提案します。

【使うべき場面】
- store_memory で新しい知識を保存する前に、関連するエンティティが既存グラフに存在するか確認する
- 「このコードレビューで言及されているクラス名はグラフに存在するか？」を調べる
- 新しいエンティティを追加する前の重複チェック

【典型的なワークフロー】
1. digest_text でテキスト中の概念がグラフに存在するか確認
2. 存在するなら既存エンティティIDを entities に含めて store_memory
3. 存在しないなら新しいエンティティとして store_memory`,
        inputSchema: zodToJsonSchema(digestTextSchema),
      },
      {
        name: 'delete_memory',
        description: `特定の Vibe Memory を ID を指定して削除します（忘却操作）。

【使うべき場面】
- 誤った情報・古くなった指摘を削除する
- 重複して保存されたメモリを整理する
- 機密情報を含む記憶を削除する

【注意】この操作は取り消せません。
memoryId は search_memory の検索結果から取得できます。`,
        inputSchema: zodToJsonSchema(deleteMemorySchema),
      },
      {
        name: 'build_communities',
        description: `グラフ全体を分析し、知識の塊（コミュニティ）を検出・要約します。

【使うべき場面】
- グラフに大量のエンティティが蓄積された後、全体俯瞰の要約が必要なとき
- プロジェクトの知識構造を定期的にレビューするとき

【重要な注意事項】
- 計算負荷が非常に高い操作です。毎回の会話で呼ぶべきではありません
- グラフに十分なエンティティ（目安: 50件以上）が存在するときのみ有効です
- 週次・月次などの定期メンテナンスでの使用を推奨します`,
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'sync_agent_logs',
        description: `Claude Code や Cursor Agent などの会話履歴を解析し、ナレッジを Gnosis に一括同期します。

【使うべき場面】
- 過去の会話セッションの知識を Gnosis に取り込む初期セットアップ時
- 長期間 Gnosis を使っていなかった後のキャッチアップ

【注意事項】
- バッチ処理のため実行時間がかかります
- 毎回の会話で呼ぶ必要はありません。初回セットアップや定期的な同期に使います
- 個別の記憶保存には store_memory / record_experience を使ってください`,
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'update_graph',
        description: `グラフ内のエンティティ情報を修正、またはリレーションを削除してナレッジを正確に保ちます。

【使うべき場面】
- エンティティの名前・説明・タイプが変わった（例: リファクタリングでクラス名変更）
- 間違った関係性（relation）を追加してしまったので削除したい
- 古くなったエンティティの description を最新の実装に合わせて更新する

【action の使い分け】
- "update_entity": エンティティの属性（name, type, description）を上書き更新
- "delete_relation": 2つのエンティティ間の特定の関係性を削除

【注意】エンティティ自体の削除は現在サポートされていません。
削除したい場合は description を "deprecated" に更新してください。`,
        inputSchema: zodToJsonSchema(updateGraphSchema),
      },
      {
        name: 'find_path',
        description: `2つのエンティティ間の最短経路（つながり）を Knowledge Graph から探索します。

【使うべき場面】
- 「このバグと過去のリファクタリングが関係しているか？」を調べる
- 2つの概念・モジュールが間接的にどうつながっているかを把握する
- 影響範囲の分析（例: "この関数の変更が認証フローに到達するか？"）

【使ってはいけない場面】
- 単一エンティティの関連情報を広く取得したい → query_graph を使う
- テキスト検索で記憶を探したい → search_memory を使う

【queryA / queryB の指定】
エンティティのID、名前、説明文いずれでも検索できます。
例: queryA="src/adapters/localllm.ts", queryB="authentication flow"`,
        inputSchema: zodToJsonSchema(
          z.object({
            queryA: z.string().describe('起点エンティティ（ID、名前、または説明文）'),
            queryB: z.string().describe('終点エンティティ（ID、名前、または説明文）'),
          }),
        ),
      },
      {
        name: 'reflect_on_memories',
        description: `未処理の Vibe Memory を分析し、エンティティと関係性を自動抽出して Knowledge Graph に統合します（自己省察）。

【使うべき場面】
- store_memory で多数の記憶を保存した後、それらをグラフ構造に自動変換したいとき
- 蓄積した記憶から自動的に知識を構造化したいとき

【ワークフローの位置づけ】
store_memory（生の記憶を保存）→ reflect_on_memories（グラフへ自動統合）→ query_graph（構造化知識を活用）

【注意事項】
- LLM を内部で呼び出すため時間がかかります
- 毎回の保存後に呼ぶ必要はありません。数十件蓄積してからまとめて実行を推奨します`,
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'record_experience',
        description: `llmharness のシナリオ実行で生じた失敗・成功イベントを、構造化された教訓として記録します。

【使うべき場面】
- llmharness でシナリオが失敗した（RISK_BLOCKING、apply 失敗など）
- llmharness でシナリオが成功し、有効なパッチを教訓として記録したい

【使ってはいけない場面】
- コードレビュー結果、設計メモ、一般的な観察の保存 → store_memory を使う
- このツールは scenarioId 単位での失敗学習専用です

【sessionId の命名規則】
- 失敗記録: "<プロジェクト名>-failures"  例: "llmharness-failures"
- 成功記録: "<プロジェクト名>-verified"  例: "llmharness-verified"

【recall_lessons との連携】
record_experience で記録した教訓は recall_lessons で検索できます。
失敗時に record_experience で記録 → 次回の同様の失敗時に recall_lessons で解決策を取得。`,
        inputSchema: zodToJsonSchema(recordExperienceSchema),
      },
      {
        name: 'recall_lessons',
        description: `llmharness のパイプライン実行中に失敗した際、過去の類似失敗から解決策・教訓を検索します。

【使うべき場面】
- llmharness シナリオが失敗し、過去に同様の失敗を解決した方法を知りたいとき
- リトライ前に「前回何が効果的だったか」を確認するとき

【使ってはいけない場面】
- 一般的な知識・設計メモを検索 → search_memory を使う
- このツールは record_experience で記録した教訓専用です

【sessionId の指定】
record_experience と同じセッションIDを指定してください。
例: "llmharness-failures"

【query の書き方】
現在のエラーメッセージや失敗状況をそのまま渡すと、セマンティック検索で類似事例を返します。
例: "RISK_BLOCKING: unused import detected in src/adapters/localllm.ts"`,
        inputSchema: zodToJsonSchema(recallLessonsSchema),
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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    // biome-ignore lint/suspicious/noExplicitAny: error checking
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error executing tool: ${error?.message || String(error)}` }],
      isError: true,
    };
  }
});
