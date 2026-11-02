import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  E2E_API_PORT,
  E2E_DATABASE_NAME,
  E2E_MIGRATION_ROLE,
  E2E_RUNTIME_ROLE,
  E2E_WEB_PORT,
  applyRuntimeDatabaseEnvironment,
  loadE2EEnvironment,
  removeDatabaseEnvironment,
  selectE2EConnection,
  validateE2EEnvironment,
} from './e2e-env.mjs';

const validEnvironment = {
  E2E_PGHOST: '127.0.0.1',
  E2E_PGPORT: '5432',
  E2E_PGDATABASE: E2E_DATABASE_NAME,
  E2E_PGUSER: E2E_RUNTIME_ROLE,
  E2E_PGPASSWORD: 'runtime-placeholder',
  E2E_MIGRATION_PGUSER: E2E_MIGRATION_ROLE,
  E2E_MIGRATION_PGPASSWORD: 'migration-placeholder',
};

test('rejects missing runtime and migration settings', () => {
  for (const missing of ['E2E_PGPASSWORD', 'E2E_MIGRATION_PGPASSWORD', 'E2E_PGUSER']) {
    const environment = { ...validEnvironment };
    delete environment[missing];
    assert.throws(
      () => validateE2EEnvironment(environment, 'api'),
      /Missing required E2E settings/,
    );
  }
});

test('accepts only ledgerline_e2e and keeps rejecting ledgerline_dev', () => {
  const valid = validateE2EEnvironment(validEnvironment, 'api');
  assert.equal(valid.database, E2E_DATABASE_NAME);

  for (const database of ['ledgerline_dev', 'ledgerline_other']) {
    assert.throws(
      () => validateE2EEnvironment({ ...validEnvironment, E2E_PGDATABASE: database }, 'api'),
      /must be exactly ledgerline_e2e/,
    );
  }
});

test('API operation requires the runtime role and migration operation requires the migration role', () => {
  assert.throws(
    () => validateE2EEnvironment({ ...validEnvironment, E2E_PGUSER: E2E_MIGRATION_ROLE }, 'api'),
    /E2E_PGUSER must be exactly ledgerline_e2e_app/,
  );
  assert.throws(
    () =>
      validateE2EEnvironment(
        { ...validEnvironment, E2E_MIGRATION_PGUSER: E2E_RUNTIME_ROLE },
        'migration',
      ),
    /E2E_MIGRATION_PGUSER must be exactly ledgerline_e2e_migrator/,
  );
});

test('rejects unknown settings and unsupported or mismatched operations', () => {
  assert.throws(
    () => validateE2EEnvironment({ ...validEnvironment, PGDATABASE: 'ledgerline_dev' }, 'api'),
    /Unexpected E2E settings/,
  );
  const apiConfig = validateE2EEnvironment(validEnvironment, 'api');
  assert.throws(
    () => selectE2EConnection(apiConfig, 'migration'),
    /validated for api, not migration/,
  );
  assert.throws(
    () => validateE2EEnvironment(validEnvironment, 'seed'),
    /operation must be either api or migration/,
  );
});

test('API connection selection and pool environment use only runtime credentials', () => {
  const configuration = validateE2EEnvironment(validEnvironment, 'api');
  const connection = selectE2EConnection(configuration, 'api');
  const apiEnvironment = {
    PGDATABASE: 'ledgerline_dev',
    PGPASSWORD: 'inherited-development-secret',
    E2E_MIGRATION_PGPASSWORD: 'migration-placeholder',
    E2E_PGPASSWORD: 'runtime-placeholder',
  };

  applyRuntimeDatabaseEnvironment(apiEnvironment, connection);

  assert.equal(connection.user, E2E_RUNTIME_ROLE);
  assert.equal(apiEnvironment.PGUSER, E2E_RUNTIME_ROLE);
  assert.equal(apiEnvironment.PGPASSWORD, 'runtime-placeholder');
  assert.equal(apiEnvironment.PGDATABASE, E2E_DATABASE_NAME);
  assert.equal(apiEnvironment.PORT, String(E2E_API_PORT));
  assert.equal('E2E_MIGRATION_PGPASSWORD' in apiEnvironment, false);
  assert.equal('E2E_PGPASSWORD' in apiEnvironment, false);
});

test('migration connection selection uses only the migration role', () => {
  const configuration = validateE2EEnvironment(validEnvironment, 'migration');
  const connection = selectE2EConnection(configuration, 'migration');

  assert.equal(connection.user, E2E_MIGRATION_ROLE);
  assert.equal(connection.password, 'migration-placeholder');
  assert.equal(connection.database, E2E_DATABASE_NAME);
  assert.notEqual(connection.password, validEnvironment.E2E_PGPASSWORD);
});

test('Playwright and frontend sanitizers remove inherited database credentials', async () => {
  const environment = {
    PGHOST: '127.0.0.1',
    PGDATABASE: E2E_DATABASE_NAME,
    PGUSER: E2E_RUNTIME_ROLE,
    PGPASSWORD: 'runtime-placeholder',
    E2E_PGPASSWORD: 'runtime-placeholder',
    E2E_MIGRATION_PGPASSWORD: 'migration-placeholder',
    E2E_MIGRATION_PGUSER: E2E_MIGRATION_ROLE,
    DATABASE_URL: 'postgres://user:secret@localhost/database',
    DB_PASSWORD: 'another-placeholder',
    E2E_API_PORT: String(E2E_API_PORT),
  };

  removeDatabaseEnvironment(environment);

  assert.deepEqual(environment, { E2E_API_PORT: String(E2E_API_PORT) });
  const playwrightSource = await readFile(
    new URL('../playwright.config.ts', import.meta.url),
    'utf8',
  );
  const frontendSource = await readFile(
    new URL('../apps/web/e2e-server.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(playwrightSource, /loadEnvFile|loadE2EEnvironment|E2E_MIGRATION_PGPASSWORD/);
  assert.ok(
    frontendSource.indexOf('removeDatabaseEnvironment(process.env)') <
      frontendSource.indexOf("await import('vite')"),
  );
  assert.ok(
    playwrightSource.indexOf('removeDatabaseEnvironment(process.env)') <
      playwrightSource.indexOf('export default defineConfig'),
  );
});

test('API wrapper configures the runtime identity before importing the API pool', async () => {
  const apiSource = await readFile(new URL('../apps/api/e2e-server.mjs', import.meta.url), 'utf8');
  assert.match(apiSource, /selectE2EConnection\(configuration, 'api'\)/);
  assert.ok(
    apiSource.indexOf('applyRuntimeDatabaseEnvironment(process.env, runtimeConnection)') <
      apiSource.indexOf("await import('./src/server.ts')"),
  );
});

test('migration wrapper selects the migration identity before importing node-pg-migrate', async () => {
  const migrationSource = await readFile(new URL('./e2e-migrate.mjs', import.meta.url), 'utf8');
  assert.match(migrationSource, /selectE2EConnection\(configuration, 'migration'\)/);
  assert.ok(
    migrationSource.indexOf("import('node-pg-migrate')") >
      migrationSource.indexOf("validateE2EEnvironment(fileEnvironment, 'migration')"),
  );
});

test('loads E2E dotenv values locally without modifying process.env', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledgerline-e2e-env-'));
  const file = join(directory, '.env.e2e');
  const previousPassword = process.env.E2E_PGPASSWORD;

  try {
    await writeFile(
      file,
      [
        'E2E_PGHOST=127.0.0.1',
        'E2E_PGPORT=5432',
        `E2E_PGDATABASE=${E2E_DATABASE_NAME}`,
        `E2E_PGUSER=${E2E_RUNTIME_ROLE}`,
        'E2E_PGPASSWORD=runtime-placeholder',
        `E2E_MIGRATION_PGUSER=${E2E_MIGRATION_ROLE}`,
        'E2E_MIGRATION_PGPASSWORD=migration-placeholder',
      ].join('\n'),
    );
    const values = await loadE2EEnvironment(file);

    assert.equal(values.E2E_PGPASSWORD, 'runtime-placeholder');
    assert.equal(values.E2E_MIGRATION_PGPASSWORD, 'migration-placeholder');
    assert.equal(process.env.E2E_PGPASSWORD, previousPassword);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('importing the migration wrapper does not connect or run migrations', async () => {
  const migrationModule = await import('./e2e-migrate.mjs');
  assert.equal(typeof migrationModule.migrateE2EDatabase, 'function');
});

test('rejects malformed PostgreSQL ports', () => {
  assert.throws(
    () => validateE2EEnvironment({ ...validEnvironment, E2E_PGPORT: '70000' }, 'api'),
    /E2E_PGPORT must be an integer/,
  );
});

test('fixed API and web ports remain distinct from development ports', () => {
  assert.equal(E2E_API_PORT, 3301);
  assert.equal(E2E_WEB_PORT, 5174);
});
