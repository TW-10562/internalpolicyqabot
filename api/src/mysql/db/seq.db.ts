import { Sequelize } from 'sequelize';
import { config } from '@/config';

const databaseUrl = process.env.DATABASE_URL;
const hasPostgresEnv =
  Boolean(databaseUrl) ||
  process.env.DB_MODE === 'postgres' ||
  Boolean(process.env.PG_HOST) ||
  Boolean(process.env.PG_PORT) ||
  Boolean(process.env.PG_USER) ||
  Boolean(process.env.PG_PASSWORD) ||
  Boolean(process.env.PG_DATABASE);

const seq = hasPostgresEnv
  ? databaseUrl
    ? new Sequelize(databaseUrl, {
        dialect: 'postgres',
        timezone: '+09:00',
        logging: false,
        define: {
          timestamps: true,
          createdAt: 'created_at',
          updatedAt: 'updated_at',
          underscored: true,
        },
        pool: {
          max: 50,
          min: 0,
          idle: 10000,
        },
        dialectOptions: {
          ssl: process.env.PG_SSL === 'true' ? { require: true, rejectUnauthorized: false } : undefined,
        },
      })
    : new Sequelize(
        process.env.PG_DATABASE || 'qa_db',
        process.env.PG_USER || 'twave_01',
        process.env.PG_PASSWORD || 'twave_01password',
        {
          dialect: 'postgres',
          host: process.env.PG_HOST || 'localhost',
          port: Number(process.env.PG_PORT || 5432),
          timezone: '+09:00',
          logging: false,
          define: {
            timestamps: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            underscored: true,
          },
          pool: {
            max: 50,
            min: 0,
            idle: 10000,
          },
          dialectOptions: {
            ssl: process.env.PG_SSL === 'true' ? { require: true, rejectUnauthorized: false } : undefined,
          },
        },
      )
  : new Sequelize(config.MySQL.database, config.MySQL.user, config.MySQL.password, {
      host: config.MySQL.host,
      port: config.MySQL.port,
      dialect: 'mysql',
      timezone: '+09:00',
      logging: false,
      define: {
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        underscored: true,
      },
      pool: {
        max: 50,
        min: 0,
        idle: 10000,
      },
      dialectOptions: {
        ssl: process.env.PG_SSL === 'true' ? { require: true, rejectUnauthorized: false } : undefined,
      },
    });

export default seq;
