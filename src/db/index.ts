import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import * as schema from './schema.js';

// 環境変数からデータベースURLを取得
const connectionString =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:7888/gnosis';

// pg pool の作成
const pool = new Pool({
  connectionString,
});

// Drizzle ORM インスタンスの作成
export const db = drizzle(pool, { schema });
