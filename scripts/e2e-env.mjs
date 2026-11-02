import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

export const E2E_DATABASE_NAME = 'ledgerline_e2e';
export const E2E_RUNTIME_ROLE = 'ledgerline_e2e_app';
export const E2E_MIGRATION_ROLE = 'ledgerline_e2e_migrator';
export const E2E_API_PORT = 3301;
export const E2E_WEB_PORT = 5174;
const DATABASE_ENVIRONMENT_NAME =
  /^(?:PG[A-Z0-9_]*|E2E_(?:MIGRATION_)?PG[A-Z0-9_]*|(?:E2E_)?(?:DATABASE|DB)_(?:URL|HOST|PORT|NAME|DATABASE|USER|USERNAME|PASSWORD)|POSTGRES_(?:HOST|PORT|DB|DATABASE|USER|USERNAME|PASSWORD))$/i;

const REQUIRED_SETTINGS = [
  'E2E_PGHOST',
  'E2E_PGPORT',
  'E2E_PGDATABASE',
  'E2E_PGUSER',
  'E2E_PGPASSWORD',
  'E2E_MIGRATION_PGUSER',
  'E2E_MIGRATION_PGPASSWORD',
];
const EXPECTED_SETTINGS = new Set(REQUIRED_SETTINGS);
const E2E_ENV_FILE = fileURLToPath(new URL('../.env.e2e', import.meta.url));

export async function loadE2EEnvironment(filePath = E2E_ENV_FILE) {
  let source;

  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      'Unable to read .env.e2e. Copy .env.e2e.example and configure both E2E roles.',
      {
        cause: error,
      },
    );
  }

  return parseEnv(source);
}

export function validateE2EEnvironment(environment, operation) {
  if (operation !== 'api' && operation !== 'migration') {
    throw new Error('E2E database operation must be either api or migration.');
  }

  const unexpected = Object.keys(environment).filter((name) => !EXPECTED_SETTINGS.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected E2E settings: ${unexpected.join(', ')}.`);
  }

  const missing = REQUIRED_SETTINGS.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required E2E settings: ${missing.join(', ')}. See .env.e2e.example.`);
  }

  if (environment.E2E_PGDATABASE.trim() !== E2E_DATABASE_NAME) {
    throw new Error(`E2E_PGDATABASE must be exactly ${E2E_DATABASE_NAME}.`);
  }
  if (environment.E2E_PGUSER.trim() !== E2E_RUNTIME_ROLE) {
    throw new Error(`E2E_PGUSER must be exactly ${E2E_RUNTIME_ROLE}.`);
  }
  if (environment.E2E_MIGRATION_PGUSER.trim() !== E2E_MIGRATION_ROLE) {
    throw new Error(`E2E_MIGRATION_PGUSER must be exactly ${E2E_MIGRATION_ROLE}.`);
  }

  const pgPort = parsePort(environment.E2E_PGPORT, 'E2E_PGPORT');
  const credentials =
    operation === 'api'
      ? { user: E2E_RUNTIME_ROLE, password: environment.E2E_PGPASSWORD }
      : { user: E2E_MIGRATION_ROLE, password: environment.E2E_MIGRATION_PGPASSWORD };

  return Object.freeze({
    host: environment.E2E_PGHOST.trim(),
    port: pgPort,
    database: E2E_DATABASE_NAME,
    credentials: Object.freeze(credentials),
    operation,
  });
}

export function selectE2EConnection(configuration, operation) {
  if (operation !== 'api' && operation !== 'migration') {
    throw new Error('E2E database operation must be either api or migration.');
  }
  if (configuration.operation !== operation) {
    throw new Error(
      `E2E configuration was validated for ${configuration.operation}, not ${operation}.`,
    );
  }

  const expectedRole = operation === 'api' ? E2E_RUNTIME_ROLE : E2E_MIGRATION_ROLE;
  if (configuration.credentials.user !== expectedRole || !configuration.credentials.password) {
    throw new Error(`Invalid database credentials selected for E2E ${operation} operation.`);
  }

  return Object.freeze({
    host: configuration.host,
    port: configuration.port,
    database: configuration.database,
    user: configuration.credentials.user,
    password: configuration.credentials.password,
  });
}

export function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}

export function removeDatabaseEnvironment(environment) {
  for (const name of Object.keys(environment)) {
    if (DATABASE_ENVIRONMENT_NAME.test(name)) {
      delete environment[name];
    }
  }
}

export function applyRuntimeDatabaseEnvironment(environment, connection) {
  removeDatabaseEnvironment(environment);
  environment.PGHOST = connection.host;
  environment.PGPORT = String(connection.port);
  environment.PGDATABASE = connection.database;
  environment.PGUSER = connection.user;
  environment.PGPASSWORD = connection.password;
  environment.PORT = String(E2E_API_PORT);
}
