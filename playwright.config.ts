import { defineConfig, type Project } from '@playwright/test';
import { loadConfig, resolveTargets, ARTIFACTS_DIR, TIMEOUTS, RECHECK_OF } from './helpers/config';
import { resolveMonitorWorkers } from './helpers/workers';
import * as path from 'path';
import * as os from 'os';

const config = loadConfig();
const targets = resolveTargets(config);

/** Проект на узел: `--project=<узел>` сужает запуск — так идёт перепроверка медленных узлов. */
const projects: Project[] = targets.map(t => ({
  name: t.name,
  metadata: { target: t.name, url: t.url },
  use: { baseURL: t.url },
}));

/**
 * Предупреждение об урезании — только в главном процессе: Playwright перечитывает конфиг в
 * каждом воркере, а там уже задан `TEST_WORKER_INDEX`.
 */
const monitorWorkers = resolveMonitorWorkers(process.env.MONITOR_WORKERS, os.cpus().length);
if (monitorWorkers.warning && process.env.TEST_WORKER_INDEX === undefined) {
  console.warn(monitorWorkers.warning);
}
const workers = monitorWorkers.workers;

/** У перепроверки свои json/html-выходы — отчёты основного прохода не затираются. Имена — как в `scripts/common.mjs`. */
const isRecheck = RECHECK_OF !== '';
const jsonOutputFile = path.join(ARTIFACTS_DIR, isRecheck ? 'last-run-recheck.json' : 'last-run.json');
const htmlOutputFolder = path.join(ARTIFACTS_DIR, isRecheck ? 'report-recheck' : 'report');

/** В режиме `--list` html/json-reporter перезаписали бы отчёты прошлого прогона пустыми. */
const isListMode = process.argv.includes('--list');

/** `retries: 0`: повтор скрыл бы деградацию, ради которой делается прогон. */
export default defineConfig({
  testDir: '.',
  // Один прогон — один сценарий: файл specs/<scenario>.spec.ts из конфига.
  testMatch: path.join('specs', `${config.scenario}.spec.ts`),
  // Один раз до старта воркеров: общий run_id.
  globalSetup: require.resolve('./helpers/global-setup'),
  timeout: TIMEOUTS.testMs,
  retries: 0,
  workers,
  // Тест один: узлы и повторы и так расходятся по воркерам.
  fullyParallel: false,
  use: {
    headless: true,
    launchOptions: {
      // Мимо системного прокси Windows: он шумит в замерах, цель — прямой доступ.
      args: ['--no-proxy-server'],
    },
    // Цель прокручивает внутренний контейнер, а не окно: fullPage-снимок не больше
    // вьюпорта. Высокое окно держит содержимое раздела в кадре.
    viewport: { width: 1280, height: 1800 },
    screenshot: 'off',
    video: 'off',
    trace: 'off',
    actionTimeout: TIMEOUTS.actionMs,
    navigationTimeout: TIMEOUTS.navigationMs,
  },
  // Консольный вывод — `reporters/live`; html, json и runs.csv — только вне `--list`: в
  // `--list` они перезаписали бы отчёты прошлого прогона пустыми.
  reporter: isListMode
    ? 'list'
    : [
        [require.resolve('./reporters/live')],
        [require.resolve('./reporters/run-record')],
        ['html', { open: 'never', outputFolder: htmlOutputFolder }],
        ['json', { outputFile: jsonOutputFile }],
      ],
  outputDir: path.join(ARTIFACTS_DIR, 'test-output'),
  metadata: { recheck_of: RECHECK_OF },
  projects,
});
