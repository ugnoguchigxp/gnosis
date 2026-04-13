import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:7888/gnosis',
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    console.log('Created vector extension successfully.');
  } finally {
    client.release();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to setup database:', err);
  process.exit(1);
});
