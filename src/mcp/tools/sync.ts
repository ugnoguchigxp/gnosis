import { syncAllAgentLogs } from '../../services/sync.js';
import { synthesizeKnowledge } from '../../services/synthesis.js';
import type { ToolEntry } from '../registry.js';

export const syncTools: ToolEntry[] = [
  {
    name: 'sync_agent_logs',
    description:
      'Claude Code や Cursor Agent などの会話履歴を解析し、ナレッジを Gnosis に一括同期します。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args) => {
      const result = await syncAllAgentLogs();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  },
  {
    name: 'reflect_on_memories',
    description:
      '未処理の Vibe Memory を分析し、エンティティと関係性を自動抽出して Knowledge Graph に統合します（自己省察）。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args) => {
      const result = await synthesizeKnowledge();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  },
];
