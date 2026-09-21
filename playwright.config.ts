import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: 'browser.spec.ts', timeout: 45000, workers: 1, use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, headless: true }, reporter: 'list' });
