import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgenticSearchRunner } from '../../services/agenticSearch/runner.js';
import {
  buildDoctorRuntimeHealth,
  recordTaskNote,
  resolveStaleMetadataSignal,
  searchKnowledgeV2,
} from '../../services/agentFirst.js';
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
const recordTaskNoteSchema = z.object({
  content: z.string().min(1),
  taskId: z.string().optional(),
  kind: z
    .enum([
      'project_doc',
      'rule',
      'procedure',
      'skill',
      'decision',
      'lesson',
      'observation',
      'risk',
      'command_recipe',
      'reference',
    ])
    .optional(),
  category: z
    .enum([
      'project_overview',
      'architecture',
      'mcp',
      'memory',
      'workflow',
      'testing',
      'operation',
      'debugging',
      'coding_convention',
      'security',
      'performance',
      'reference',
    ])
    .optional(),
  title: z.string().optional(),
  purpose: z.string().optional(),
  tags: z.array(z.string()).optional(),
  evidence: z
    .array(
      z.object({
        type: z.string().optional(),
        value: z.string().optional(),
        uri: z.string().optional(),
      }),
    )
    .optional(),
  files: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  confidence: z.number().optional(),
  source: z.enum(['manual', 'task', 'review', 'onboarding', 'import']).optional(),
});
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

const agenticSearchRunner = new AgenticSearchRunner();

export const agentFirstTools: ToolEntry[] = [
  {
    name: 'initial_instructions',
    description: 'Agent-First の最小運用ルールを返す。',
    inputSchema: zodToJsonSchema(initialInstructionsSchema) as Record<string, unknown>,
    handler: async () => ({
      content: [
        {
          type: 'text',
          text: [
            '# Gnosis MCP ツール利用ガイド',
            '',
            '## Primary Tools（知識管理）',
            '',
            '- agentic_search: 知識取得の主導線。タスク文脈を渡すと必要な知識だけを返す。',
            '  - 一般技術質問はプロジェクト固有語を混ぜず一般化キーワードで調査する',
            '  - 根拠不足なら brave_search → fetch と段階的に深掘りする',
            '- search_knowledge: raw候補・スコアの低レベル確認用。通常は agentic_search を使う。',
            '- record_task_note: 再利用可能な知見（rule/lesson/procedure等）を保存する。verify合格後に登録を検討する。',
            '- review_task: コード差分・ドキュメント・計画のレビュー。知識注入型。',
            '- doctor: ランタイム状態・DB接続・メタデータ整合性の診断。',
            '',
            '## Commit時の登録ルール',
            '',
            '- verify gate 合格後、commit 直前に今回作業から再利用可能な知識を抽出する。',
            '- 以下は MCP の record_task_note で登録する。',
            '  - 教訓（lesson）',
            '  - 追加すべきルール（rule）',
            '  - 追加すべき手続き（procedure）',
            '- 登録内容は汎用化し、実行条件・失敗条件・検証手順を短く含める。',
            '- commit 完了後に登録漏れが判明した場合は、同一文脈で追記登録する。',
            '',
            '## Astmend（TypeScript AST エンジン）',
            '',
            'TypeScript コードを AST レベルで解析・変換する。各ツールに _from_text / _from_file / _from_project の3モードがある。',
            '',
            '- analyze_code_units_*: 関数・クラス・型等のコード単位を一覧する。',
            '- resolve_symbol_candidates_*: シンボル名から AST 上の候補を特定する。',
            '- analyze_references_*: シンボルの参照箇所と影響範囲を解析する。',
            '- batch_analyze_references_*: 複数シンボルの参照解析を一括実行する。',
            '- detect_impact_*: シンボル変更の影響を受ける宣言を検出する。',
            '- analyze_import_export_graph_*: import/export の依存グラフを解析する。',
            '- apply_patch_*: AST パッチを適用する（dry-run、差分を返す）。',
            '- rename_symbol_*: シンボルとその参照を一括リネームする。',
            '',
            '## DiffGuard（差分の安全性チェック）',
            '',
            '- review_diff: unified diff に安全性ルールを適用し findings を返す。',
            '- review_batch: 複数 diff を一括レビューする。',
            '',
            '## 運用原則',
            '',
            '- 完了前にセルフレビューし verify gate を実行する。',
          ].join('\n'),
        },
      ],
    }),
  },
  {
    name: 'agentic_search',
    description: 'JSON入力を解析し、agentic_search runner を実行する。',
    inputSchema: zodToJsonSchema(agenticSearchSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = agenticSearchSchema.parse(args);
      const result = await agenticSearchRunner.run(input);

      return {
        content: [
          {
            type: 'text',
            text: result.answer,
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
