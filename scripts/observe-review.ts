import { getDashboard } from '../src/services/review/metrics/dashboard.js';
import { loadLocalEnv } from './lib/quality.js';

const run = async () => {
  loadLocalEnv();

  const dashboard = await getDashboard();

  process.stdout.write('[observe:review] local review summary\n');
  process.stdout.write(
    `  precision=${dashboard.weeklyKPIs.precisionRate.toFixed(2)} zeroFpDays=${
      dashboard.weeklyKPIs.zeroFpDays
    } knowledgeContribution=${dashboard.weeklyKPIs.knowledgeContributionRate.toFixed(2)}\n`,
  );
  process.stdout.write(
    `  guidance principles=${dashboard.guidanceSummary.activePrinciples} heuristics=${dashboard.guidanceSummary.activeHeuristics} patterns=${dashboard.guidanceSummary.activePatterns} degraded=${dashboard.guidanceSummary.degradedCount}\n`,
  );
};

run().catch((error) => {
  process.stdout.write(
    `[observe:review] skipped: ${error instanceof Error ? error.message : String(error)}\n`,
  );
});
