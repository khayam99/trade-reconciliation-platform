import { defineConfig } from '@playwright/test';
import {
  E2E_API_PORT,
  E2E_WEB_PORT,
  removeDatabaseEnvironment,
} from './scripts/e2e-env.mjs';

const apiURL = `http://127.0.0.1:${E2E_API_PORT}`;
const baseURL = `http://127.0.0.1:${E2E_WEB_PORT}`;

// Playwright workers and webServer children inherit this process environment.
// Credentials are loaded only inside the API and migration wrappers.
removeDatabaseEnvironment(process.env);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'npm run e2e --workspace=@trade-recon/api',
      url: `${apiURL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run e2e --workspace=@trade-recon/web',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        E2E_WEB_PORT: String(E2E_WEB_PORT),
        VITE_API_PROXY_TARGET: apiURL,
      },
    },
  ],
});
