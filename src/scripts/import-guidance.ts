import { mkdir, rename } from 'node:fs/promises';
import { config } from '../config.js';
import { importGuidanceArchives } from '../services/guidance.js';

type CliArgs = {
  inboxDir?: string;
  dryRun: boolean;
  project?: string;
  maxZips?: number;
};

const parseArgs = (argv: string[]): CliArgs => {
  const getArg = (key: string): string | undefined => {
    const index = argv.indexOf(key);
    if (index < 0 || index + 1 >= argv.length) return undefined;
    return argv[index + 1];
  };

  const dryRun = argv.includes('--dry-run');
  const inboxDir = getArg('--inbox-dir');
  const project = getArg('--project') ?? config.guidance.project;
  const maxZipsRaw = getArg('--max-zips');
  const maxZips = maxZipsRaw ? Number.parseInt(maxZipsRaw, 10) : undefined;

  return {
    inboxDir,
    dryRun,
    project,
    maxZips,
  };
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await importGuidanceArchives({
    inboxDir: args.inboxDir,
    dryRun: args.dryRun,
    project: args.project,
    maxZips: args.maxZips,
  });

  const lines = [
    `Scanned: ${summary.scanned}`,
    `Imported: ${summary.imported}`,
    `Updated: ${summary.updated}`,
    `Unchanged: ${summary.unchanged}`,
    `Failed: ${summary.failed}`,
    `Chunks imported: ${summary.chunksImported}`,
  ];

  console.log(lines.join('\n'));

  for (const result of summary.results) {
    const suffix = result.error ? ` error=${result.error}` : '';
    console.log(
      `${result.status.toUpperCase()} ${result.zipPath} chunks=${result.chunkCount}${suffix}`,
    );

    // インポート後にファイルを移動 (dryRunでない場合)
    if (!args.dryRun) {
      try {
        const destDir =
          result.status === 'failed' ? config.guidance.failedDir : config.guidance.processedDir;
        await mkdir(destDir, { recursive: true });
        const destPath = `${destDir}/${Date.now()}_${result.zipPath.split('/').pop()}`;
        await rename(result.zipPath, destPath);
        console.log(`Moved to ${destPath}`);
      } catch (moveError) {
        console.error(`Failed to move ${result.zipPath}:`, moveError);
      }
    }
  }

  if (summary.failed > 0) {
    process.exit(1);
  }
}


main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
