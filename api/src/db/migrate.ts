import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool, PoolConfig } from 'pg';

const APP_NAME = 'api';

function buildPgConfig(): PoolConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    };
  }

  return {
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'twave_01',
    password: process.env.PG_PASSWORD || 'twave_01password',
    database: process.env.PG_DATABASE || 'qa_db',
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  };
}

function checksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function runPostgresMigrations(): Promise<void> {
  const pool = new Pool(buildPgConfig());
  const dir = path.resolve(__dirname, './migrations/postgres');
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        app_name TEXT NOT NULL,
        version TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (app_name, version)
      )
    `);

    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      const hash = checksum(sql);

      const existing = await client.query(
        `SELECT checksum FROM schema_migrations WHERE app_name = $1 AND version = $2`,
        [APP_NAME, version],
      );

      if (existing.rowCount && existing.rows[0].checksum === hash) {
        continue;
      }

      if (existing.rowCount && existing.rows[0].checksum !== hash) {
        throw new Error(`Migration checksum mismatch for ${version}. Create a new migration file instead of editing applied SQL.`);
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (app_name, version, checksum) VALUES ($1, $2, $3)`,
          [APP_NAME, version, hash],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}
