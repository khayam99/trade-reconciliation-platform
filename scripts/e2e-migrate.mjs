import {
  E2E_DATABASE_NAME,
  loadE2EEnvironment,
  removeDatabaseEnvironment,
  selectE2EConnection,
  validateE2EEnvironment,
} from './e2e-env.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function migrateE2EDatabase(direction = process.argv[2] ?? 'up') {
  const fileEnvironment = await loadE2EEnvironment();
  const configuration = validateE2EEnvironment(fileEnvironment, 'migration');
  const migrationConnection = selectE2EConnection(configuration, 'migration');

  if (direction !== 'up' && direction !== 'down') {
    throw new Error('Usage: npm run db:migrate:e2e -- [up|down]');
  }

  removeDatabaseEnvironment(process.env);
  const { runner } = await import('node-pg-migrate');

  await runner({
    databaseUrl: {
      host: migrationConnection.host,
      port: migrationConnection.port,
      database: E2E_DATABASE_NAME,
      user: migrationConnection.user,
      password: migrationConnection.password,
    },
    dir: 'db/migrations',
    migrationsTable: 'pgmigrations',
    direction,
    singleTransaction: true,
    verbose: true,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await migrateE2EDatabase();
}
