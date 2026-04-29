import { and, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../src/config.js';
import { closeDbPool, db } from '../src/db/index.js';
import { entities, vibeMemories } from '../src/db/schema.js';

type Scope = 'always' | 'on_demand';
type ChangeType =
  | 'frontend'
  | 'backend'
  | 'api'
  | 'auth'
  | 'db'
  | 'docs'
  | 'test'
  | 'mcp'
  | 'refactor'
  | 'config'
  | 'build'
  | 'review';

type AppliesWhen = {
  intents?: Array<'plan' | 'edit' | 'debug' | 'review' | 'finish'>;
  changeTypes?: ChangeType[];
  fileGlobs?: string[];
  technologies?: string[];
  keywords?: string[];
  severity?: 'blocking' | 'required' | 'advisory';
};

type Classification = {
  scope: Scope;
  category: string;
  priority: number;
  appliesWhen: AppliesWhen;
  reason: string;
};

const ALWAYS_PATTERNS = [
  /initial_instructions/i,
  /review_task.*initial_instructions/i,
  /git\s*(add|commit|push)/i,
  /git操作.*禁止/i,
  /コミット・PR作成前ユーザー確認/,
  /認証バイパス.*禁止/,
  /auth(?:entication)? bypass/i,
  /機密情報.*保存禁止/,
  /大きなロールバック/,
  /破壊的.*ユーザー/,
  /prisma migrate reset/i,
  /本番DB直接操作禁止/,
  /\.envファイル変更.*禁止/,
  /サーバー独自起動禁止/,
];

const WORKFLOW_ALWAYS_PATTERNS = [
  /作業前TODO作成/,
  /コード変更時.*build/i,
  /pnpm build\/test/i,
  /lint.*型チェック/i,
];

const DOMAIN_SPECIFIC_TITLE_PATTERNS = [
  /必須コーディング規約/,
  /バックエンド固有/,
  /フロントエンド固有/,
  /API実装/,
  /API仕様/,
  /React Query/i,
  /バックエンド DI/i,
  /テスト/,
];

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
}

function add<T extends string>(set: Set<T>, condition: boolean, value: T) {
  if (condition) set.add(value);
}

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value.toLowerCase()));
}

function classify(
  title: string,
  content: string,
  tags: string[],
  currentPriority?: number,
): Classification {
  const text = `${title}\n${content}\n${tags.join(' ')}`.toLowerCase();
  const originalText = `${title}\n${content}`;
  const changeTypes = new Set<ChangeType>();
  const technologies = new Set<string>();
  const keywords = new Set<string>();
  const fileGlobs = new Set<string>();
  let category = 'coding_convention';

  add(
    changeTypes,
    includesAny(text, ['frontend', 'react', 'tsx', 'ui', 'component', 'i18next']),
    'frontend',
  );
  add(
    changeTypes,
    includesAny(text, ['backend', 'service', 'repository', 'controller', 'tsyringe']),
    'backend',
  );
  add(
    changeTypes,
    includesAny(text, ['api', 'openapi', 'endpoint', 'route', 'fetch', 'axios']),
    'api',
  );
  add(changeTypes, includesAny(text, ['auth', 'msal', '認証', '権限', 'token']), 'auth');
  add(
    changeTypes,
    includesAny(text, ['database', 'db', 'prisma', 'drizzle', 'sql', 'migrate']),
    'db',
  );
  add(
    changeTypes,
    includesAny(text, ['document', 'docs', 'markdown', '.md', 'ドキュメント', '仕様書']),
    'docs',
  );
  add(
    changeTypes,
    includesAny(text, ['test', 'vitest', 'coverage', 'testing-library', 'テスト']),
    'test',
  );
  add(
    changeTypes,
    includesAny(text, [
      'mcp',
      'agent-first',
      'initial_instructions',
      'search_knowledge',
      'review_task',
    ]),
    'mcp',
  );
  add(
    changeTypes,
    includesAny(text, ['refactor', 'リファクタ', 'dry', 'kiss', 'yagni', '600行', '複雑化']),
    'refactor',
  );
  add(
    changeTypes,
    includesAny(text, ['config', '設定', 'tsconfig', 'biome', 'eslint', '.env']),
    'config',
  );
  add(changeTypes, includesAny(text, ['build', 'lint', 'typecheck', 'pnpm', 'eslint']), 'build');
  add(changeTypes, includesAny(text, ['review', 'レビュー']), 'review');

  add(
    technologies,
    includesAny(text, ['typescript', 'tsyringe', 'zod', 'tsx', 'tsconfig']),
    'typescript',
  );
  add(technologies, includesAny(text, ['react', 'react query', 'tanstack']), 'react');
  add(technologies, includesAny(text, ['tanstack']), 'tanstack-query');
  add(technologies, includesAny(text, ['i18next']), 'i18next');
  add(technologies, includesAny(text, ['zod']), 'zod');
  add(technologies, includesAny(text, ['drizzle']), 'drizzle');
  add(technologies, includesAny(text, ['prisma']), 'prisma');
  add(technologies, includesAny(text, ['mcp']), 'mcp');
  add(technologies, includesAny(text, ['bun']), 'bun');
  add(technologies, includesAny(text, ['svelte']), 'svelte');
  add(technologies, includesAny(text, ['rust', 'tauri']), 'rust');

  if (changeTypes.has('frontend')) fileGlobs.add('apps/**');
  if (changeTypes.has('backend')) fileGlobs.add('src/services/**');
  if (changeTypes.has('api')) fileGlobs.add('src/**/routes/**');
  if (changeTypes.has('db')) fileGlobs.add('drizzle/**');
  if (changeTypes.has('docs')) fileGlobs.add('docs/**');
  if (changeTypes.has('test')) fileGlobs.add('test/**');
  if (changeTypes.has('mcp')) fileGlobs.add('src/mcp/**');
  if (changeTypes.has('config')) {
    fileGlobs.add('*.json');
    fileGlobs.add('*.toml');
  }

  if (changeTypes.has('mcp')) category = 'mcp';
  else if (changeTypes.has('db') || changeTypes.has('auth')) category = 'security';
  else if (changeTypes.has('test')) category = 'testing';
  else if (changeTypes.has('docs')) category = 'workflow';
  else if (changeTypes.has('refactor')) category = 'architecture';
  else if (changeTypes.has('frontend') || changeTypes.has('backend') || changeTypes.has('api')) {
    category = 'coding_convention';
  }

  for (const tag of tags) keywords.add(tag.toLowerCase());
  if (title.trim()) keywords.add(title.toLowerCase());

  const domainSpecificTitle = DOMAIN_SPECIFIC_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const alwaysBySafety =
    !domainSpecificTitle && ALWAYS_PATTERNS.some((pattern) => pattern.test(originalText));
  const alwaysByWorkflow = WORKFLOW_ALWAYS_PATTERNS.some((pattern) => pattern.test(originalText));
  const scope: Scope = alwaysBySafety || alwaysByWorkflow ? 'always' : 'on_demand';
  const priority =
    scope === 'always' ? 100 : Math.min(90, Math.max(50, Math.trunc(currentPriority ?? 80)));

  return {
    scope,
    category,
    priority,
    appliesWhen:
      scope === 'always'
        ? { severity: alwaysBySafety ? 'blocking' : 'required' }
        : {
            intents: ['plan', 'edit', 'debug', 'review'],
            changeTypes: [...changeTypes],
            fileGlobs: [...fileGlobs],
            technologies: [...technologies],
            keywords: [...keywords].slice(0, 12),
            severity: 'required',
          },
    reason: alwaysBySafety
      ? 'global safety guardrail'
      : alwaysByWorkflow
        ? 'global workflow guardrail'
        : 'task-specific implementation guidance',
  };
}

async function reclassifyGuidanceMemories(apply: boolean) {
  const rows = await db
    .select({
      id: vibeMemories.id,
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
    })
    .from(vibeMemories)
    .where(
      and(
        eq(vibeMemories.sessionId, config.guidance.sessionId),
        sql`${vibeMemories.metadata} @> '{"kind":"guidance","guidanceType":"rule"}'::jsonb`,
      ),
    );

  const changes: Array<{ id: string; title: string; from: string; to: Scope; reason: string }> = [];
  for (const row of rows) {
    const metadata = metadataRecord(row.metadata);
    const title = typeof metadata.title === 'string' ? metadata.title : row.content.slice(0, 80);
    const tags = stringArray(metadata.tags);
    const currentPriority =
      typeof metadata.priority === 'number' ? metadata.priority : Number(metadata.priority ?? 80);
    const next = classify(title, row.content, tags, currentPriority);
    const currentScope = metadata.scope === 'always' ? 'always' : 'on_demand';
    changes.push({ id: row.id, title, from: currentScope, to: next.scope, reason: next.reason });
    if (!apply) continue;
    await db
      .update(vibeMemories)
      .set({
        metadata: {
          ...metadata,
          scope: next.scope,
          priority: next.priority,
          category: next.category,
          appliesWhen: next.appliesWhen,
          scopeClassification: {
            reason: next.reason,
            classifiedAt: new Date().toISOString(),
            classifiedBy: 'scripts/reclassify-guidance-rules.ts',
          },
        },
      })
      .where(eq(vibeMemories.id, row.id));
  }
  return changes;
}

async function reclassifyRuleEntities(apply: boolean) {
  const rows = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      description: entities.description,
      metadata: entities.metadata,
      scope: entities.scope,
    })
    .from(entities)
    .where(inArray(entities.type, ['rule', 'constraint']));

  const changes: Array<{ id: string; title: string; from: string; to: Scope; reason: string }> = [];
  for (const row of rows) {
    const metadata = metadataRecord(row.metadata);
    const tags = stringArray(metadata.tags);
    const currentPriority =
      typeof metadata.priority === 'number' ? metadata.priority : Number(metadata.priority ?? 80);
    const next = classify(row.name, row.description ?? '', tags, currentPriority);
    const currentScope = row.scope === 'always' ? 'always' : 'on_demand';
    changes.push({
      id: row.id,
      title: row.name,
      from: currentScope,
      to: next.scope,
      reason: next.reason,
    });
    if (!apply) continue;
    await db
      .update(entities)
      .set({
        scope: next.scope,
        metadata: {
          ...metadata,
          guidanceType: metadata.guidanceType ?? 'rule',
          scope: next.scope,
          priority: next.priority,
          category: next.category,
          appliesWhen: next.appliesWhen,
          scopeClassification: {
            reason: next.reason,
            classifiedAt: new Date().toISOString(),
            classifiedBy: 'scripts/reclassify-guidance-rules.ts',
          },
        },
      })
      .where(eq(entities.id, row.id));
  }
  return changes;
}

function summarize(label: string, changes: Array<{ from: string; to: Scope; reason: string }>) {
  const summary = changes.reduce<Record<string, number>>((acc, change) => {
    const key = `${change.from}->${change.to}:${change.reason}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(label);
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const memoryChanges = await reclassifyGuidanceMemories(apply);
  const entityChanges = await reclassifyRuleEntities(apply);
  console.log(
    apply
      ? 'APPLIED guidance rule scope classification'
      : 'DRY RUN guidance rule scope classification',
  );
  summarize('vibe_memories guidance rules', memoryChanges);
  summarize('entities rule/constraint', entityChanges);

  const movedToOnDemand = [...memoryChanges, ...entityChanges]
    .filter((change) => change.from === 'always' && change.to === 'on_demand')
    .slice(0, 20)
    .map((change) => ({ id: change.id, title: change.title }));
  const alwaysKept = [...memoryChanges, ...entityChanges]
    .filter((change) => change.to === 'always')
    .slice(0, 20)
    .map((change) => ({ id: change.id, title: change.title, reason: change.reason }));
  console.log('movedToOnDemandSample');
  console.log(JSON.stringify(movedToOnDemand, null, 2));
  console.log('alwaysKeptSample');
  console.log(JSON.stringify(alwaysKept, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
