import { defineConfig, devices } from '@playwright/test';

// End-to-end tests: the built web app (vite preview) talking to tests/e2e/mock-server.js.
// on GitHub (CI) two: three workers on its four cores, with the Claude Code tests' bridge processes, timed those tests out
const WORKERS = Number(process.env.E2E_WORKERS || (process.env.CI ? 2 : 3));
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false, // the tests of one file run in order, in one worker
  // files are spread over a few workers, each with its own mock server (helpers.js picks 8788 + the worker's slot)
  workers: WORKERS,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // a trace only for a failed test's second try on GitHub: recording every test cost about a third of the run's CPU
  use: { ...devices['Pixel 7'], baseURL: 'http://localhost:4173', trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure' },
  webServer: [
    { command: 'npx vite build && npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI, timeout: 120_000 },
    ...Array.from({ length: WORKERS }, (_, i) => ({ command: `MOCK_PORT=${8788 + i} node tests/e2e/mock-server.js`, url: `http://localhost:${8788 + i}/v1/models`, reuseExistingServer: !process.env.CI })),
  ],
});
