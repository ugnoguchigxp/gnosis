import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { experienceLogs } from '../src/db/schema.js';
import { recallExperienceLessons, saveExperience } from '../src/services/experience.js';

async function main() {
  const testSession = `test-session-${Date.now()}`;
  const testScenario = 'test-scenario-001';

  console.log('--- Testing record_experience (via service with defaults simulated) ---');
  try {
    // In actual MCP tool, zod handles defaults. Here we simulate it.
    const saved = await saveExperience({
      sessionId: testSession,
      scenarioId: 'manual-record', // simulated default
      attempt: 1, // simulated default
      type: 'failure',
      content: 'Database connection timeout occurred during migration.',
      failureType: 'CONNECTION_ERROR',
      metadata: { detail: 'ECONNREFUSED 127.0.0.1:7888' },
    });

    console.log('Successfully saved experience. ID:', saved.id);

    // Verify in DB
    const rows = await db.select().from(experienceLogs).where(eq(experienceLogs.id, saved.id));
    if (rows.length > 0) {
      console.log('Verification: Row found in database.');
    } else {
      console.error('Verification: Row NOT found in database!');
    }

    console.log('\n--- Testing recallExperienceLessons ---');
    // Save a success case for the same scenario to test lesson retrieval
    await saveExperience({
      sessionId: testSession,
      scenarioId: testScenario,
      attempt: 2,
      type: 'success',
      content: 'Fixed by updating the host IP in .env file.',
      metadata: { fixType: 'config' },
    });

    const lessons = await recallExperienceLessons(testSession, 'connection timeout migration');
    console.log('Found lessons Count:', lessons.length);
    if (lessons.length > 0) {
      console.log('Top failure content:', lessons[0].failure.content);
      console.log('Solutions count:', lessons[0].solutions.length);
      if (lessons[0].solutions.length > 0) {
        console.log('First solution content:', lessons[0].solutions[0].content);
      }
    }
  } catch (error) {
    console.error('Error during testing:', error);
  } finally {
    process.exit(0);
  }
}

main();
