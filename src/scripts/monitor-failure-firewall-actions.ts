import { and, eq, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { failureFirewallGoldenPaths, failureFirewallPatterns } from '../db/schema.js';
import { parseArgMap, readStringFlag } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const action = readStringFlag(args, 'action');
  const kind = readStringFlag(args, 'kind');
  const id = readStringFlag(args, 'id');

  if (!action || !['approve', 'deprecate', 'increment-fp'].includes(action)) {
    throw new Error('--action must be approve|deprecate|increment-fp');
  }
  if (!kind || !['golden_path', 'pattern'].includes(kind)) {
    throw new Error('--kind must be golden_path|pattern');
  }
  if (!id) {
    throw new Error('--id is required');
  }

  const tableExists = async (table: string): Promise<boolean> => {
    const result = await db.execute(sql`SELECT to_regclass(${table}) AS reg`);
    const row = result.rows[0] as { reg?: string | null } | undefined;
    return typeof row?.reg === 'string' && row.reg.length > 0;
  };

  const goldenExists = await tableExists('failure_firewall_golden_paths');
  const patternExists = await tableExists('failure_firewall_patterns');

  if (kind === 'golden_path') {
    if (!goldenExists) {
      process.stdout.write(
        renderOutput(
          { success: false, reason: 'table_not_found', table: 'failure_firewall_golden_paths' },
          outputFormat,
        ),
      );
      return;
    }
    if (action === 'increment-fp') {
      throw new Error('increment-fp is supported only for pattern');
    }
    if (action === 'approve') {
      const updated = await db
        .update(failureFirewallGoldenPaths)
        .set({ status: 'active', updatedAt: new Date() })
        .where(
          and(
            eq(failureFirewallGoldenPaths.id, id),
            eq(failureFirewallGoldenPaths.status, 'needs_review'),
          ),
        )
        .returning({ id: failureFirewallGoldenPaths.id });
      if (updated.length === 0) {
        throw new Error('approve failed: record not found or status is not needs_review');
      }
      process.stdout.write(
        renderOutput({ success: true, kind, id, action, status: 'active' }, outputFormat),
      );
      return;
    }
    const updated = await db
      .update(failureFirewallGoldenPaths)
      .set({ status: 'deprecated', updatedAt: new Date() })
      .where(
        and(eq(failureFirewallGoldenPaths.id, id), eq(failureFirewallGoldenPaths.status, 'active')),
      )
      .returning({ id: failureFirewallGoldenPaths.id });
    if (updated.length === 0) {
      throw new Error('deprecate failed: record not found or status is not active');
    }
    process.stdout.write(
      renderOutput({ success: true, kind, id, action, status: 'deprecated' }, outputFormat),
    );
    return;
  }

  if (!patternExists) {
    process.stdout.write(
      renderOutput(
        { success: false, reason: 'table_not_found', table: 'failure_firewall_patterns' },
        outputFormat,
      ),
    );
    return;
  }

  if (action === 'approve') {
    const updated = await db
      .update(failureFirewallPatterns)
      .set({ status: 'active', updatedAt: new Date() })
      .where(
        and(eq(failureFirewallPatterns.id, id), eq(failureFirewallPatterns.status, 'needs_review')),
      )
      .returning({ id: failureFirewallPatterns.id });
    if (updated.length === 0) {
      throw new Error('approve failed: record not found or status is not needs_review');
    }
    process.stdout.write(
      renderOutput({ success: true, kind, id, action, status: 'active' }, outputFormat),
    );
    return;
  }
  if (action === 'deprecate') {
    const updated = await db
      .update(failureFirewallPatterns)
      .set({ status: 'deprecated', updatedAt: new Date() })
      .where(and(eq(failureFirewallPatterns.id, id), eq(failureFirewallPatterns.status, 'active')))
      .returning({ id: failureFirewallPatterns.id });
    if (updated.length === 0) {
      throw new Error('deprecate failed: record not found or status is not active');
    }
    process.stdout.write(
      renderOutput({ success: true, kind, id, action, status: 'deprecated' }, outputFormat),
    );
    return;
  }

  const updated = await db
    .update(failureFirewallPatterns)
    .set({
      falsePositiveCount: sql`${failureFirewallPatterns.falsePositiveCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(failureFirewallPatterns.id, id))
    .returning({ id: failureFirewallPatterns.id });
  if (updated.length === 0) {
    throw new Error('increment-fp failed: pattern not found');
  }
  process.stdout.write(renderOutput({ success: true, kind, id, action }, outputFormat));
};

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
