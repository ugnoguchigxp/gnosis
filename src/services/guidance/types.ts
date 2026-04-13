import type { GuidanceScope, GuidanceType } from '../../domain/schemas.js';

export const DEFAULT_GUIDANCE_SESSION_ID = 'guidance-registry';

export type GuidanceImportState = {
  zipHash?: string;
  mtimeMs?: number;
  size?: number;
  importedChunks?: number;
  importedAt?: string;
  archiveKey?: string;
};

export type GuidanceImportItemResult = {
  zipPath: string;
  status: 'unchanged' | 'imported' | 'updated' | 'failed';
  chunkCount: number;
  error?: string;
};

export type GuidanceImportSummary = {
  scanned: number;
  imported: number;
  updated: number;
  unchanged: number;
  failed: number;
  chunksImported: number;
  results: GuidanceImportItemResult[];
};

export type ImportGuidanceOptions = {
  inboxDir?: string;
  guidanceSessionId?: string;
  maxFilesPerZip?: number;
  maxZipSizeBytes?: number;
  maxChunkChars?: number;
  maxFileChars?: number;
  dryRun?: boolean;
  project?: string;
  maxZips?: number;
};

export type GuidanceArchiveFile = {
  zipPath: string;
  size: number;
  mtimeMs: number;
};

export type GuidanceMemoryRow = {
  sessionId: string;
  content: string;
  embedding: number[];
  dedupeKey: string;
  metadata: Record<string, unknown>;
};

export type PersistImportInput = {
  stateId: string;
  stateExists: boolean;
  guidanceSessionId: string;
  archiveKey: string;
  previousArchiveKey?: string;
  rows: GuidanceMemoryRow[];
  cursor: GuidanceImportState;
  now: Date;
};

export type GuidanceImportRepository = {
  getState: (stateId: string) => Promise<{ cursor: unknown } | null>;
  persistImport: (input: PersistImportInput) => Promise<void>;
};

export type GuidanceImportDependencies = {
  listArchiveFiles: (inboxDir: string) => Promise<GuidanceArchiveFile[]>;
  listZipEntries: (zipPath: string) => Promise<string[]>;
  readZipEntryText: (zipPath: string, entry: string) => Promise<string>;
  computeFileHash: (zipPath: string) => Promise<string>;
  generateEmbedding: (text: string) => Promise<number[]>;
  repository: GuidanceImportRepository;
  now: () => Date;
};
