/**
 * Сценарий «день X второго тура»: вход и таблица дня X второго тура олимпиад школьников.
 * Опции тура — константа этого файла.
 */
import { test } from '@playwright/test';
import { runCabinetScenario } from './cabinet';

test('олимпиада школьников: день X второго тура', async ({ page }, testInfo) =>
  runCabinetScenario(page, testInfo, { round: { secondRound: true, dayXOnly: true } }));
