/**
 * Юнит-тесты без globalSetup и без проектов — все `*.unit.ts` этого каталога.
 *
 * `@playwright/test` — без пути: резолвится вверх в `node_modules` бандла, как в `smoke.config.ts`.
 */
import { defineConfig } from '@playwright/test';
import * as path from 'path';

export default defineConfig({
  testDir: __dirname,
  testMatch: '*.unit.ts',
  reporter: 'line',
  workers: 1,
  // Иначе Playwright резолвит outputDir от текущего каталога процесса.
  outputDir: path.join(__dirname, '..', 'artifacts', '_dev', 'unit-output'),
});
