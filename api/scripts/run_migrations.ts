import { runPostgresMigrations } from '@/db/migrate';

(async () => {
  try {
    console.log('Running Postgres migrations...');
    await runPostgresMigrations();
    console.log('Migrations completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Migrations failed:', err);
    process.exit(1);
  }
})();
