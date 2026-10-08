import { defineConfig, devices } from '@playwright/test';

// The app is started by the platform or by the developer, not by the test
// runner. PLAYWRIGHT_BASE_URL can also point at a deployed Rails container.
//
// Chromium's local-network protection blocks a test page on one loopback
// origin from framing the app on another. Production never serves a frame from
// loopback, so the check is switched off for the test browser only.
const launchOptions = {
  args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'],
};

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.mjs',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000',
    headless: true,
    launchOptions,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1365, height: 960 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
});
