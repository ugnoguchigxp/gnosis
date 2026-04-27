import { syncAllAgentLogs } from '../services/sync.js';

async function main() {
  if (process.env.GNOSIS_ENABLE_AUTOMATION !== 'true') {
    console.log('[sync] Automation is OFF. Skipping scheduled sync.');
    process.exit(0);
  }

  console.log('--- Gnosis Automated Knowledge Sync ---');
  console.log(`Time: ${new Date().toLocaleString()}`);

  try {
    const summary = await syncAllAgentLogs();

    if (summary.imported > 0) {
      console.log('\nSync Completed Successfully!');
      console.log(`Sources: ${summary.sources.join(', ')}`);
      console.log(`Total New Items: ${summary.imported}`);
    } else {
      console.log('\nNo new data to import.');
    }
  } catch (error) {
    console.error('\nSync Failed with Critical Error:');
    console.error(error);
    process.exit(1);
  }

  process.exit(0);
}

main();
