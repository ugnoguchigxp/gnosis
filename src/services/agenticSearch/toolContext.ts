import type { AgenticSearchToolName } from './types.js';

export function buildToolFollowupContext(toolName: AgenticSearchToolName): string {
  if (toolName === 'knowledge_search') {
    return [
      'knowledge_search結果を読んで次を判断する。',
      'lesson は過去知見、rule は制約、procedure は実行手順として扱う。',
      '結果が空、または依頼に直接答えられない場合は brave_search に切り替える。',
      '一般技術質問ではプロジェクト固有語を検索語に含めず、一般化キーワードで検索する。',
    ].join('\n');
  }
  if (toolName === 'brave_search') {
    return [
      'brave_search結果を読んで次を判断する。',
      'snippetで十分なら回答してよい。',
      '根拠不足なら fetch で本文取得する。',
    ].join('\n');
  }
  return [
    'fetch結果を読んで次を判断する。',
    '本文の事実だけで回答する。',
    '不足なら追加fetchまたは追加検索を検討する。',
  ].join('\n');
}
