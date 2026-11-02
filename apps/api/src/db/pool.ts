import { Pool } from 'pg';

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `Missing required database setting: ${name}. Copy .env.example to .env and set it.`,
    );
  }

  return value;
}

const port = Number(process.env.PGPORT ?? '5432');

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PGPORT must be an integer between 1 and 65535.');
}

export const pool = new Pool({
  host: process.env.PGHOST?.trim() || '127.0.0.1',
  port,
  database: requiredEnvironmentVariable('PGDATABASE'),
  user: requiredEnvironmentVariable('PGUSER'),
  password: requiredEnvironmentVariable('PGPASSWORD'),
  application_name: 'ledgerline-api',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 10,
});

pool.on('error', (error) => {
  console.error('Unexpected error from an idle PostgreSQL connection.', error);
});
