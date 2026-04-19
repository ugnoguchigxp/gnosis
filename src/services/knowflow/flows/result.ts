import type { DetectedGap } from '../gap/detector';
import type { ExplorationReport } from '../report/explorationReport';

/**
 * cronFlow と userFlow の統一結果型。
 * すべてのフローはこの型を返す。
 */
export type FlowResult = {
  summary: string;
  changed: boolean;
  usedBudget: number;

  // 検証メトリクス
  acceptedClaims: number;
  rejectedClaims: number;
  conflicts: number;

  // ギャップ情報 — 常に DetectedGap[] を返す
  gaps: DetectedGap[];

  // レポート（userFlow などの詳細なレポートが必要な場合）
  report?: ExplorationReport;

  // cronFlow 固有
  runConsumedBudget?: number;
};
