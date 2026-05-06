export const CURRENT_PUBLIC_MCP_TOOLS = [
  'initial_instructions',
  'agentic_search',
  'search_knowledge',
  'record_task_note',
  'review_task',
  'doctor',
  'memory_search',
  'memory_fetch',
] as const;

export function buildAuthoritativePublicSurfaceContext(): string {
  return [
    'Gnosis MCP の現行 public surface は次の8つを扱う。',
    `current_public_tools: ${CURRENT_PUBLIC_MCP_TOOLS.join(', ')}`,
    '主導線は agentic_search / search_knowledge / record_task_note / review_task / doctor で、memory_search / memory_fetch は context 圧縮回避の補助導線。',
    '取得した過去knowledgeがこの一覧と衝突する場合は、この current_public_tools を優先する。',
    '旧 lifecycle 導線は推奨手順として扱わず、最終回答では名前を出さない。',
  ].join('\n');
}
