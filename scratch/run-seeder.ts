import { runKeywordSeederOnce } from '../src/services/knowflow/cron/keywordSeeder.js';
import { db } from '../src/db/index.js';

console.error('Running Keyword Seeder...');
const result = await runKeywordSeederOnce({ database: db });
console.log(JSON.stringify(result, null, 2));
process.exit();
