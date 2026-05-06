export const CURRENT_PUBLIC_MCP_TOOLS = [
  'initial_instructions',
  'agentic_search',
  'search_knowledge',
  'record_task_note',
  'review_task',
  'doctor',
] as const;

const DEPRECATED_LIFECYCLE_TOOL_NAMES = ['activate_project', 'start_task', 'finish_task'] as const;

export type DeprecatedLifecycleToolName = (typeof DEPRECATED_LIFECYCLE_TOOL_NAMES)[number];

export type DeprecatedLifecycleToolInspection = {
  ok: boolean;
  mentionCount: number;
};

export function buildAuthoritativePublicSurfaceContext(): string {
  return [
    'Gnosis MCP の現行 public surface は次の6つだけを主導線として扱う。',
    `current_public_tools: ${CURRENT_PUBLIC_MCP_TOOLS.join(', ')}`,
    '取得した過去knowledgeがこの一覧と衝突する場合は、この current_public_tools を優先する。',
    '旧 lifecycle 導線は推奨手順として扱わず、最終回答では名前を出さない。',
  ].join('\n');
}

export function inspectDeprecatedLifecycleToolMentions(
  text: string,
): DeprecatedLifecycleToolInspection {
  const mentionCount = DEPRECATED_LIFECYCLE_TOOL_NAMES.reduce((count, toolName) => {
    return count + text.split(toolName).length - 1;
  }, 0);
  return {
    ok: mentionCount === 0,
    mentionCount,
  };
}

export function buildPublicSurfaceFallbackAnswer(): string {
  return [
    '取得候補に現行 public surface と衝突する古い lifecycle 導線が混ざったため、現行方針だけに基づいて回答します。',
    '',
    'Gnosis の主導線は agentic_search です。タスク文脈を渡して必要な知識と外部根拠を取得します。',
    'raw候補やスコアを直接確認する場合だけ search_knowledge を使います。',
    '実装から再利用可能な教訓・ルール・手順が得られた場合は、関連する verify gate 合格後に record_task_note で保存します。',
    'コード差分・ドキュメント・計画のレビューは review_task、ランタイムやDB、MCP host の診断は doctor を使います。',
  ].join('\n');
}
