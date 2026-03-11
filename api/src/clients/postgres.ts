import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

export const pgPool = new Pool(
  databaseUrl
    ? {
        connectionString: databaseUrl,
        max: 10,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 2_000,
      }
    : {
        user: process.env.PG_USER || 'twave_01',
        host: process.env.PG_HOST || 'localhost',
        database: process.env.PG_DATABASE || 'qa_db',
        password: process.env.PG_PASSWORD || 'twave_01password',
        port: Number(process.env.PG_PORT || 5432),
        max: 10,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 2_000,
        ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      },
);
