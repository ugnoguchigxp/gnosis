import type { AgenticSearchToolName } from './types.js';

export function buildToolFollowupContext(toolName: AgenticSearchToolName): string {
  if (toolName === 'knowledge_search') {
    return [
      'knowledge_search結果を読んで次を判断する。',
      'lesson は過去知見、rule は制約、procedure は実行手順、concept は調査済み技術知識、all は通常の entity 横断検索として扱う。',
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
  if (toolName === 'memory_search') {
    return [
      'memory_search結果を読んで次を判断する。',
      'これは context 圧縮で欠けた過去会話・作業断片を補助確認する raw memory 導線であり、entity knowledge の代替ではない。',
      '必要な候補だけ memory_fetch で部分取得し、現行ファイル・ユーザー指示・entity knowledge と照合して使う。',
    ].join('\n');
  }
  if (toolName === 'memory_fetch') {
    return [
      'memory_fetch結果を読んで次を判断する。',
      '返された excerpt は raw memory の必要部分だけであり、現在の実装事実としては扱わない。',
      '判断に使う場合は、現行ファイルまたは明示的なユーザー指示と照合する。',
    ].join('\n');
  }
  return [
    'fetch結果を読んで次を判断する。',
    '本文の事実だけで回答する。',
    '不足なら追加fetchまたは追加検索を検討する。',
  ].join('\n');
}
