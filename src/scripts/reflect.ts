#!/usr/bin/env bun
/**
 * 定期実行（Cron）用の省察・統合スクリプト
 */
import { envBoolean } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { synthesizeKnowledge } from '../services/synthesis.js';

async function main() {
  const automationEnabled = envBoolean(
    process.env.GNOSIS_ENABLE_AUTOMATION,
    GNOSIS_CONSTANTS.AUTOMATION_ENABLED_DEFAULT,
  );
  if (!automationEnabled) {
    console.log('[reflect] Automation is OFF. Skipping scheduled reflect.');
    process.exit(0);
  }

  console.log('--- Gnosis Reflective Synthesis Start ---');
  try {
    const result = await synthesizeKnowledge();
    if (result.count > 0) {
      console.log(`Successfully synthesized ${result.count} memories.`);
      console.log(
        `Added/Updated ${result.extractedEntities} entities and ${result.extractedRelations} relations.`,
      );
    } else {
      console.log('No memories were processed.');
    }
  } catch (error) {
    console.error('Error during synthesis:', error);
    process.exit(1);
  }
  console.log('--- Gnosis Reflective Synthesis End ---');
}

main();
