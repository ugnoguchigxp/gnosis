import os from 'node:os';
import path from 'node:path';

/**
 * プロジェクト全体の設定管理
 */
export const config = {
  // LLM スクリプトのパス
  llmScript:
    process.env.GNOSIS_LLM_SCRIPT || path.join(os.homedir(), 'Code/localLlm/scripts/gemma4'),

  // エンティティ抽出/マージ時のタイムアウト (ms)
  llmTimeoutMs: Number(process.env.GNOSIS_LLM_TIMEOUT_MS || '90000'),

  // 埋め込みベクトルの生成コマンド
  embedCommand: process.env.GNOSIS_EMBED_COMMAND || path.join(os.homedir(), '.local/bin/embed'),

  // ベクトルの次元数
  embeddingDimension: Number(process.env.GNOSIS_EMBEDDING_DIMENSION || '384'),

  // 自動デデュープ（重複排除）の類似度閾値
  dedupeThreshold: Number(process.env.GNOSIS_DEDUPE_THRESHOLD || '0.9'),

  // 各種ログのディレクトリパス
  claudeLogDir: process.env.GNOSIS_CLAUDE_LOG_DIR || path.join(os.homedir(), '.claude/projects'),
  antigravityLogDir:
    process.env.GNOSIS_ANTIGRAVITY_LOG_DIR || path.join(os.homedir(), '.gemini/antigravity/brain'),

  // 自己省察のバッチサイズ
  synthesisBatchSize: 10,

  // 連想検索の最大ホップ数
  maxPathHops: 5,

  // データベース接続情報 (Drizzle用)
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:7888/gnosis',
};
