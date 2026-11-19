/**
 * Сценарий «день X»: вход и таблица дня X первого тура олимпиад школьников.
 * Опции тура — константа этого файла.
 */
import { test } from '@playwright/test';
import { runCabinetScenario } from './cabinet';

test('олимпиада школьников: вход и таблица дня X', async ({ page }, testInfo) =>
  runCabinetScenario(page, testInfo, { round: { dayXOnly: true } }));
