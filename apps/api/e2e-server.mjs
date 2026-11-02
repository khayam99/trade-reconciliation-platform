import {
  applyRuntimeDatabaseEnvironment,
  loadE2EEnvironment,
  selectE2EConnection,
  validateE2EEnvironment,
} from '../../scripts/e2e-env.mjs';

const fileEnvironment = await loadE2EEnvironment();
const configuration = validateE2EEnvironment(fileEnvironment, 'api');
const runtimeConnection = selectE2EConnection(configuration, 'api');

// Do not copy migration credentials into this process. The API pool receives
// only the validated runtime role through the PG* names it already uses.
applyRuntimeDatabaseEnvironment(process.env, runtimeConnection);

// Import the API only after the E2E database name and role have been validated.
await import('./src/server.ts');
