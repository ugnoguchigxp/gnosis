import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config.js';
import * as schema from './schema.js';

// pg pool の作成
const pool = new Pool({
  connectionString: config.databaseUrl,
});

// Drizzle ORM インスタンスの作成
export const db = drizzle(pool, { schema });
