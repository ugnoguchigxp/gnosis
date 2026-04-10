import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: 'postgres://postgres:postgres@localhost:7888/gnosis',
});

async function main() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
  console.log('Created vector extension successfully.');
  process.exit(0);
}

main().catch(console.error);
