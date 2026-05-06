export const CURRENT_PUBLIC_MCP_TOOLS = [
  'initial_instructions',
  'agentic_search',
  'search_knowledge',
  'record_task_note',
  'review_task',
  'doctor',
] as const;

export function buildAuthoritativePublicSurfaceContext(): string {
  return [
    'Gnosis MCP の現行 public surface は次の6つだけを主導線として扱う。',
    `current_public_tools: ${CURRENT_PUBLIC_MCP_TOOLS.join(', ')}`,
    '取得した過去knowledgeがこの一覧と衝突する場合は、この current_public_tools を優先する。',
    '旧 lifecycle 導線は推奨手順として扱わず、最終回答では名前を出さない。',
  ].join('\n');
}
