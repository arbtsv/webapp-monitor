/**
 * Офлайн-смоук: один сквозной путь через конвейер замеров и отчёта — настоящий
 * `playwright.config.ts` бандла (проекты, globalSetup, воркеры, reporter'ы) → хелперы
 * замеров и снимков → CSV и снимки → `scripts/report.mjs`. Каркас повторяет
 * `specs/cabinet.ts`, но вместо кабинета — фиктивные замеры и `page.setContent`;
 * адрес из `env.smoke.json` не открывается.
 *
 * Узлы:
 *   - `srv1`  — все замеры в норме, тест проходит;
 *   - `srv10` — `signin_page_ms` выше порога (x2.5): тест падает на итоговом `expect`,
 *     снимок помечен `pass` — исключения не было;
 *   - `srv2`  — исключение с маркером `smoke-ansi-error` и настоящими ANSI-кодами
 *     (очистка в `report.mjs` и `reporters/live.ts`), снимок помечен `fail`.
 * Порядок узлов в `env.smoke.json` (`srv10`, `srv2`, `srv1`) нарочно не natural sort:
 * в отчёте он должен идти по конфигу.
 */
import { test, expect, type TestInfo, type Page } from '@playwright/test';
import { loadConfig } from '../helpers/config';
import { recordMetric, runId, type MetricResult } from '../helpers/metrics';
import { screenshotPath } from '../helpers/artifacts';

const config = loadConfig();
const RUN_ID = runId();

// ESC собран через String.fromCharCode, а не литеральным управляющим
// символом в исходнике — иначе редактор/diff/ESLint (no-control-regex у
// потребителей этого текста) увидели бы настоящий control-char в файле.
const ESC = String.fromCharCode(27);

/** Фиктивные длительности шагов «а»/«б»/«в» по узлам, мс. `srv10` — превышение порога. */
const DURATIONS_MS: Record<string, [number, number, number]> = {
  srv10: [2500, 900, 800],
  srv2: [900, 800, 500],
  srv1: [900, 800, 500]
};

/** 200–1200 мс — чтобы порядок завершения узлов менялся от прогона к прогону. */
function randomDelay(): Promise<void> {
  const ms = 200 + Math.floor(Math.random() * 1000);
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

test('смоук: сквозной прогон через playwright.config.ts, хелперы и report.mjs', async ({
  page
}, testInfo) => {
  const { target, url } = testInfo.project.metadata as { target: string; url: string };
  const ctx = { environment: config.environment, target, url, runId: RUN_ID };
  const results: MetricResult[] = [];
  let failed = true;

  // Проверка сквозного пути с самого начала: --no-proxy-server должен дойти
  // до launchOptions проекта именно из настоящего playwright.config.ts.
  expect(testInfo.project.use.launchOptions?.args).toContain('--no-proxy-server');

  // Один раз на тест: reporters/live.ts должен переслать оба потока воркеров
  // без потери строк — маркеры видны в выводе прогона.
  // eslint-disable-next-line no-console
  console.log('smoke-stdout-marker');
  // eslint-disable-next-line no-console
  console.warn('smoke-stderr-marker');

  const [d1, d2, d3] = DURATIONS_MS[target] ?? [900, 800, 500];

  try {
    await test.step('а) страница входа', async () => {
      await randomDelay();
      results.push(recordMetric(ctx, 'signin_page_ms', d1, config.thresholds.signin_page_ms));
    });

    await test.step('б) вход в кабинет', async () => {
      await randomDelay();
      if (target === 'srv2') {
        throw new Error(`smoke-ansi-error: ${ESC}[2mприглушённый${ESC}[22m фрагмент текста ошибки`);
      }
      results.push(recordMetric(ctx, 'login_ms', d2, config.thresholds.login_ms));
    });

    await test.step('в) раздел тура', async () => {
      await randomDelay();
      results.push(recordMetric(ctx, 'section_ms', d3, config.thresholds.section_ms));
    });

    failed = false;
  } finally {
    await captureScreenshot(page, testInfo, target, failed);
  }

  await testInfo.attach('timings', {
    body: JSON.stringify(
      { run_id: RUN_ID, environment: config.environment, target, url, metrics: results },
      null,
      2
    ),
    contentType: 'application/json'
  });

  const slow = results.filter(r => r.failure);
  expect(slow.map(r => r.failure).join('\n'), slow.map(r => r.failure).join('\n')).toBe('');
});

/** Зеркалит captureScreenshot настоящей спеки — снимок в любом исходе. */
async function captureScreenshot(
  page: Page,
  testInfo: TestInfo,
  target: string,
  failed: boolean
): Promise<void> {
  const file = screenshotPath(RUN_ID, target, failed ? 'fail' : 'pass', testInfo);
  try {
    await page.setContent('<html><body>смоук webapp-monitor</body></html>');
    await page.screenshot({ path: file });
  } catch {
    // Снимок — диагностика, не проверка; его неудача не должна подменять
    // настоящую причину падения теста (как в настоящей спеке).
  }
}
