import pkg from 'pg';
const { Client } = pkg;
// Note: using hardcoded DB URL if process.env.DATABASE_URL is missing
const DATABASE_URL = 'postgres://postgres:postgres@localhost:7888/gnosis';

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  console.log('--- Checking vibe_memories constraints ---');
  const constraints = await client.query(`
    SELECT conname 
    FROM pg_constraint 
    WHERE conrelid = 'vibe_memories'::regclass;
  `);
  console.log(
    'Constraints:',
    constraints.rows.map((r) => r.conname),
  );

  const hasConstraint = constraints.rows.some(
    (r) => r.conname === 'vibe_memories_session_dedupe_key_unique',
  );

  if (!hasConstraint) {
    console.log('Constraint is missing. Checking for duplicates...');
    const dups = await client.query(`
      SELECT session_id, dedupe_key, count(*) 
      FROM vibe_memories 
      GROUP BY session_id, dedupe_key 
      HAVING count(*) > 1;
    `);

    if (dups.rows.length > 0) {
      console.log(`Found ${dups.rows.length} duplicate groups. Cleaning up...`);
      // Keep the latest one for each group
      await client.query(`
        DELETE FROM vibe_memories a USING (
          SELECT MIN(ctid) as ctid, session_id, dedupe_key
          FROM vibe_memories 
          GROUP BY session_id, dedupe_key 
          HAVING count(*) > 1
        ) b
        WHERE a.session_id = b.session_id 
          AND a.dedupe_key = b.dedupe_key 
          AND a.ctid <> b.ctid;
      `);
      console.log('Duplicates removed.');
    }

    console.log('Adding unique constraint...');
    await client.query(`
      ALTER TABLE vibe_memories 
      ADD CONSTRAINT vibe_memories_session_dedupe_key_unique UNIQUE (session_id, dedupe_key);
    `);
    console.log('Constraint added successfully.');
  } else {
    console.log('Constraint already exists.');
  }

  await client.end();
}

main().catch(console.error);
