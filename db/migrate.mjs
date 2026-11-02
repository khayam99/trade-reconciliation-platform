import { runner } from 'node-pg-migrate';

const direction = process.argv[2] ?? 'up';

if (direction !== 'up' && direction !== 'down') {
  throw new Error('Usage: node db/migrate.mjs [up|down]');
}

const database = {
  host: process.env.PGHOST?.trim() || '127.0.0.1',
  port: Number(process.env.PGPORT ?? '5432'),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
};

for (const name of ['PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
  if (!process.env[name]?.trim()) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and set the local PostgreSQL connection.`,
    );
  }
}

if (!Number.isInteger(database.port) || database.port < 1 || database.port > 65_535) {
  throw new Error('PGPORT must be an integer between 1 and 65535.');
}

await runner({
  databaseUrl: database,
  dir: 'db/migrations',
  migrationsTable: 'pgmigrations',
  direction,
  singleTransaction: true,
  verbose: true,
});
