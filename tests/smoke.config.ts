/**
 * Офлайн-смоук конвейера замеров и отчёта: разворачивает настоящий
 * `playwright.config.ts` бандла целиком (проекты из `env.smoke.json`, globalSetup, воркеры,
 * reporter'ы, `outputDir`), подменяя только каталог и маску тестов.
 *
 * `@playwright/test` — без пути: резолвится вверх в `node_modules` бандла.
 */
// Первым: окружение смоука до загрузки конфига бандла.
import './smoke-env';
import { defineConfig } from '@playwright/test';
import realConfig from '../playwright.config';

export default defineConfig(realConfig, {
  testDir: __dirname,
  testMatch: '*.smoke.ts',
});
