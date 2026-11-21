/**
 * Сценарий «день X второго тура»: вход и таблица дня X второго тура веб-кабинета.
 * Опции раздела — константа этого файла.
 */
import { test } from '@playwright/test';
import { runCabinetScenario } from './cabinet';

test('веб-кабинет: день X второго тура', async ({ page }, testInfo) =>
  runCabinetScenario(page, testInfo, { round: { secondRound: true, dayXOnly: true } }));
