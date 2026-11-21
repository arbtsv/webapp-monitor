/**
 * Офлайн-тесты снятия QuickEdit (`scripts/console-mode.mjs`): состав вызова PowerShell
 * и контракт результата disableQuickEdit. Сам вызов с изменением консоли тестами не
 * гоняется (как сетевые шаги install) — только чистые части; отказ возвращается
 * результатом, а не бросается.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { pathToFileURL } from 'url';

interface ConsoleModeApi {
  powershellQuickEditOffArgs: () => string[];
  disableQuickEdit: (timeoutMs?: number) => { ok: boolean; reason: string };
}

async function loadApi(): Promise<ConsoleModeApi> {
  const mod = await import(
    pathToFileURL(path.join(path.resolve(__dirname, '..'), 'scripts', 'console-mode.mjs')).href
  );
  return mod as ConsoleModeApi;
}

test('powershellQuickEditOffArgs: ключи безопасного неинтерактивного вызова', async () => {
  const api = await loadApi();
  const args = api.powershellQuickEditOffArgs();
  expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  expect(args).toHaveLength(4);
});

test('powershellQuickEditOffArgs: снимает ENABLE_QUICK_EDIT_MODE (0x40), держит EXTENDED_FLAGS (0x80)', async () => {
  const api = await loadApi();
  const cmd = api.powershellQuickEditOffArgs()[3];
  expect(cmd).toContain('kernel32.dll');
  expect(cmd).toContain('GetConsoleMode');
  expect(cmd).toContain('SetConsoleMode');
  expect(cmd).toContain('GetStdHandle(-10)'); // STD_INPUT_HANDLE
  expect(cmd).toContain('-bnot [uint32]0x40'); // маска снятия QuickEdit
  expect(cmd).toContain('-bor [uint32]0x80'); // ENABLE_EXTENDED_FLAGS при записи режима
  expect(cmd.match(/exit 1/g)).toHaveLength(2); // неуспех GetConsoleMode или SetConsoleMode — ненулевой код
  expect(cmd).not.toContain('\n'); // один аргумент — без переводов строк
});

test('disableQuickEdit: результат, а не исключение; вне Windows — мягкий отказ', async () => {
  const api = await loadApi();
  const r = api.disableQuickEdit(1);
  expect(typeof r.ok).toBe('boolean');
  expect(typeof r.reason).toBe('string');
  if (process.platform !== 'win32') {
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Windows');
  }
});
