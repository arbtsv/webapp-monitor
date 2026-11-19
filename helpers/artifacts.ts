/**
 * Имя и место снимка экрана. Отчёт отбирает снимки по префиксу `<run_id>-`, поэтому
 * формат имени и `sanitize` совпадают с `scripts/common.mjs`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ARTIFACTS_DIR } from './config';

export const SCREENSHOT_DIR = path.join(ARTIFACTS_DIR, 'screenshots');

/** Подмножество `TestInfo` — чтобы файл не зависел от `@playwright/test`. */
export interface ScreenshotAttempt {
  repeatEachIndex: number;
  retry: number;
}

/**
 * `<run_id>-<узел>-r<repeatEachIndex>[-retry<retry>]-<pass|fail>.png`. Индекс повтора
 * не даёт повторам `--repeat-each` затирать друг друга.
 */
export function screenshotPath(
  runIdValue: string,
  target: string,
  outcome: 'pass' | 'fail',
  attempt: ScreenshotAttempt
): string {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const retrySuffix = attempt.retry > 0 ? `-retry${attempt.retry}` : '';
  const name = `${sanitize(runIdValue)}-${sanitize(target)}-r${attempt.repeatEachIndex}${retrySuffix}-${outcome}.png`;
  return path.join(SCREENSHOT_DIR, name);
}

// run_id тоже: заданный вручную MONITOR_RUN_ID может нести символы, недопустимые в пути.
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
