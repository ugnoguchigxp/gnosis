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
          text: JSON.stringify(
            {
              defaultKnowledgeTool: 'agentic_search',
              rawSearchTool: 'search_knowledge',
              reviewTool: 'review_task',
              saveKnowledgeTool: 'record_task_note',
              diagnosticTool: 'doctor',
              agenticSearchOperatingPrinciples: [
                '一般技術質問はプロジェクト固有語を混ぜず、一般化キーワードで調査する',
                'プロジェクト固有文脈は依頼が明示するときのみ使う',
                'knowledge_searchで根拠不足ならbrave_searchへ切り替える',
                'brave_searchのsnippetで不足ならfetchで本文確認する',
              ],
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
