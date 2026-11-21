/**
 * Сценарий «день X»: вход и таблица дня X первого тура веб-кабинета.
 * Опции раздела — константа этого файла.
 */
import { test } from '@playwright/test';
import { runCabinetScenario } from './cabinet';

test('веб-кабинет: вход и таблица дня X', async ({ page }, testInfo) =>
  runCabinetScenario(page, testInfo, { round: { dayXOnly: true } }));
