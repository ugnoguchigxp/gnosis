// Re-export all public APIs
export { DEFAULT_GUIDANCE_SESSION_ID } from './types.js';
export type {
  GuidanceArchiveFile,
  GuidanceImportDependencies,
  GuidanceImportItemResult,
  GuidanceImportState,
  GuidanceImportSummary,
  GuidanceMemoryRow,
  ImportGuidanceOptions,
  PersistImportInput,
} from './types.js';

export { importGuidanceArchives } from './import.js';
export { getAlwaysOnGuidance, getGuidanceContext, getOnDemandGuidance } from './search.js';
export { saveGuidance } from './register.js';

// Internal utilities (not re-exported)
// - chunking.ts: splitMarkdownIntoChunks, uniqueStrings
// - zip.ts: listZipEntries, readZipEntryText, computeFileHash, isSafeZipEntryPath
