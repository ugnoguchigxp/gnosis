import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config.js';
import * as schema from './schema.js';

const createDatabase = (pool: InstanceType<typeof Pool>) => drizzle(pool, { schema });

type Database = ReturnType<typeof createDatabase>;

let pool: InstanceType<typeof Pool> | null = null;
let database: Database | null = null;

function ensureDatabase(): Database {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
    });
  }
  if (!database) {
    database = createDatabase(pool);
  }
  return database;
}

export function getDb(): Database {
  return ensureDatabase();
}

export function getDbPool(): InstanceType<typeof Pool> {
  ensureDatabase();
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool;
}

export async function closeDbPool(): Promise<void> {
  if (!pool) {
    return;
  }
  const currentPool = pool;
  pool = null;
  database = null;
  await currentPool.end();
}

// Keep the historical `db` export, but initialize the pool lazily so unit tests
// do not create PostgreSQL connection machinery just by importing a module.
export const db = new Proxy({} as Database, {
  get(_target, property, receiver) {
    return Reflect.get(ensureDatabase() as object, property, receiver);
  },
}) as Database;
