/**
 * Юнит-тесты предела `MONITOR_WORKERS`: `maxMonitorWorkers`/`resolveMonitorWorkers` из
 * `helpers/workers.ts` — фиксированное число процессоров (детерминизм), малые машины и
 * реальное `os.cpus().length`.
 */
import { test, expect } from '@playwright/test';
import * as os from 'os';
import { maxMonitorWorkers, resolveMonitorWorkers } from '../helpers/workers';

const CPU = 12;
const MAX = 6; // maxMonitorWorkers(12)

test('resolveMonitorWorkers: пусто/пробелы -> 1 без предупреждения', () => {
  expect(resolveMonitorWorkers(undefined, CPU)).toEqual({ workers: 1, warning: null });
  expect(resolveMonitorWorkers('', CPU)).toEqual({ workers: 1, warning: null });
  expect(resolveMonitorWorkers('   ', CPU)).toEqual({ workers: 1, warning: null });
});

test('resolveMonitorWorkers: целое в пределах — без предупреждения', () => {
  expect(resolveMonitorWorkers('1', CPU)).toEqual({ workers: 1, warning: null });
  expect(resolveMonitorWorkers('6', CPU)).toEqual({ workers: MAX, warning: null });
});

test('resolveMonitorWorkers: целое сверх предела — урезание с предупреждением', () => {
  expect(resolveMonitorWorkers('7', CPU)).toEqual({
    workers: MAX,
    warning: 'MONITOR_WORKERS=7 урезано до 6 (логических процессоров: 12)'
  });
  // Запрошено столько же, сколько логических процессоров: урезание до половины.
  expect(resolveMonitorWorkers('12', CPU)).toEqual({
    workers: MAX,
    warning: 'MONITOR_WORKERS=12 урезано до 6 (логических процессоров: 12)'
  });
});

test('resolveMonitorWorkers: проценты — пересчёт выражением Playwright, предел на результат', () => {
  expect(resolveMonitorWorkers('100%', CPU)).toEqual({
    workers: MAX,
    warning: 'MONITOR_WORKERS=100% урезано до 6 (логических процессоров: 12)'
  });
  expect(resolveMonitorWorkers('50%', CPU)).toEqual({ workers: 6, warning: null }); // ровно предел
  expect(resolveMonitorWorkers('25%', CPU)).toEqual({ workers: 3, warning: null });
  expect(resolveMonitorWorkers('1%', CPU)).toEqual({ workers: 1, warning: null });
});

test('resolveMonitorWorkers: пробелы вокруг значения обрезаются, в предупреждении — без них', () => {
  expect(resolveMonitorWorkers(' 7 ', CPU)).toEqual({
    workers: MAX,
    warning: 'MONITOR_WORKERS=7 урезано до 6 (логических процессоров: 12)'
  });
});

test('resolveMonitorWorkers: нераспознанное значение — исключение, называющее переменную и значение', () => {
  for (const raw of ['abc', '0', '0%', '101%', '-1', '2.5', '4 %']) {
    expect(() => resolveMonitorWorkers(raw, CPU)).toThrow(`MONITOR_WORKERS="${raw}" не распознан`);
  }
});

test('maxMonitorWorkers: малые машины и пустой os.cpus()', () => {
  expect(maxMonitorWorkers(1)).toBe(1);
  expect(maxMonitorWorkers(2)).toBe(1);
  expect(maxMonitorWorkers(3)).toBe(1);
  expect(maxMonitorWorkers(0)).toBe(1);
});

test('resolveMonitorWorkers: cpuCount = 1', () => {
  expect(resolveMonitorWorkers('1', 1)).toEqual({ workers: 1, warning: null });
  expect(resolveMonitorWorkers('2', 1)).toEqual({
    workers: 1,
    warning: 'MONITOR_WORKERS=2 урезано до 1 (логических процессоров: 1)'
  });
  expect(resolveMonitorWorkers('100%', 1)).toEqual({ workers: 1, warning: null });
});

test('resolveMonitorWorkers: реальное число процессоров — предел, урезание сверх него, исключение на мусор', () => {
  const cpu = os.cpus().length;
  const max = maxMonitorWorkers(cpu);
  expect(resolveMonitorWorkers('1', cpu)).toEqual({ workers: 1, warning: null });
  expect(resolveMonitorWorkers(String(max), cpu)).toEqual({ workers: max, warning: null });
  expect(resolveMonitorWorkers(String(max + 1), cpu)).toEqual({
    workers: max,
    warning: `MONITOR_WORKERS=${max + 1} урезано до ${max} (логических процессоров: ${cpu})`
  });
  const hundred = resolveMonitorWorkers('100%', cpu);
  expect(hundred.workers).toBe(max);
  if (cpu > max) {
    expect(hundred.warning).toBe(`MONITOR_WORKERS=100% урезано до ${max} (логических процессоров: ${cpu})`);
  } else {
    expect(hundred.warning).toBeNull();
  }
  expect(() => resolveMonitorWorkers('abc', cpu)).toThrow('MONITOR_WORKERS="abc" не распознан');
});
