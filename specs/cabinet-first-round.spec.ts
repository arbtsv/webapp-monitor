/**
 * Сценарий «первый тур»: вход и раздел первого тура веб-кабинета.
 * Опции раздела — константа этого файла.
 */
import { test } from '@playwright/test';
import { runCabinetScenario } from './cabinet';

test('веб-кабинет: вход и раздел первого тура', async ({ page }, testInfo) =>
  runCabinetScenario(page, testInfo, { round: {} }));
