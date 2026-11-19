/**
 * Сценарий «первый тур»: вход и раздел первого тура олимпиад школьников.
 * Опции тура — константа этого файла.
 */
import { test } from '@playwright/test';
import { runCabinetScenario } from './cabinet';

test('олимпиада школьников: вход и раздел первого тура', async ({ page }, testInfo) =>
  runCabinetScenario(page, testInfo, { round: {} }));
