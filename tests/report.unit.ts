/**
 * Офлайн-тесты `scripts/report.mjs`. Чтение `metrics.csv`: отчёт берёт файл с точки входа по
 * `started_at` прогона из `runs.csv` (`readCsvTail`), а не целиком; нет строки прогона в
 * `runs.csv` — читает целиком. Состав архива прогона: HTML-отчёт(ы) и снимки этого прогона
 * списком, с именами записей под `screenshots/` — чужой остаток общего каталога не попадает.
 *
 * Каждый случай пишет фикстуру в свежий `artifacts/_dev/report-unit/<случай>/`; рабочий
 * `artifacts/` не трогается. Архив собирает настоящий PowerShell — тест только для Windows.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

const BUNDLE_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(BUNDLE_ROOT, 'scripts', 'report.mjs');
const CASES_ROOT = path.join(BUNDLE_ROOT, 'artifacts', '_dev', 'report-unit');

const METRICS_HEADER =
  'timestamp,environment,target,url,metric,duration_ms,reference_ms,ratio,max_ratio,verdict,run_id';
const RUNS_HEADER =
  'run_id,started_at,config_file,environment,host,cpu_count,workers,targets,scenario,recheck_of,timeouts,node_version,playwright_version,bundle_version';
const METRIC_IDS = ['signin_page_ms', 'login_ms', 'olymp_tree_ms'];

const RUN = '20260929-120000';
const RECHECK = `${RUN}-recheck`;
const OLD_RUN = '20260101-090000';
const START = '2026-09-29T12:00:00.000Z';

function csvLine(header: string, cells: Record<string, string>): string {
  return header
    .split(',')
    .map(c => cells[c] ?? '')
    .join(',');
}

function metricLine(ts: string, target: string, metric: string, duration: number, runId: string): string {
  return csvLine(METRICS_HEADER, {
    timestamp: ts,
    environment: 'test',
    target,
    url: `http://${target}.invalid/`,
    metric,
    duration_ms: String(duration),
    reference_ms: '500',
    ratio: '1',
    max_ratio: '2',
    verdict: 'ok',
    run_id: runId,
  });
}

function runsLine(runId: string, startedAt: string): string {
  return csvLine(RUNS_HEADER, {
    run_id: runId,
    started_at: startedAt,
    config_file: 'env.json',
    environment: 'test',
    host: 'host',
    cpu_count: '1',
    workers: '1',
    targets: 'srv1;srv2',
    scenario: 'cabinet',
    timeouts: 'default:30000/180000/30000/60000',
    node_version: 'v20.0.0',
    playwright_version: '1.61.0',
    bundle_version: '4.0.0',
  });
}

/** Метка времени через `offsetSec` секунд от `START`: метки монотонно растут, как в живом файле. */
function tsAt(offsetSec: number): string {
  return new Date(Date.parse(START) + offsetSec * 1000).toISOString();
}

interface Fixture {
  dir: string;
  metricsLines: string[];
}

/**
 * metrics.csv: «призрак» — строка прогона RUN с меткой давно до `started_at` (целиком читающий
 * отчёт увидит узел ghost, читающий с точки входа — нет), 3000 строк старого прогона, затем строки
 * RUN двух узлов, записанные вперемешку, и строки перепроверки.
 */
function buildFixture(name: string, { withRunsRow }: { withRunsRow: boolean }): Fixture {
  const dir = path.join(CASES_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const metricsLines: string[] = [metricLine('2026-01-01T09:00:00.000Z', 'ghost', 'login_ms', 111, RUN)];
  for (let i = 0; i < 3000; i += 1) {
    const ts = new Date(Date.parse('2026-01-01T09:00:01.000Z') + i * 1000).toISOString();
    metricsLines.push(metricLine(ts, 'srv1', METRIC_IDS[i % 3], 400 + (i % 50), OLD_RUN));
  }
  // Строки прохода: последний по времени узел дописался раньше первого.
  const runRows: Array<[number, string, string, number]> = [
    [5, 'srv2', 'signin_page_ms', 1200],
    [3, 'srv1', 'signin_page_ms', 1100],
    [9, 'srv2', 'login_ms', 1300],
    [8, 'srv1', 'login_ms', 1400],
    [12, 'srv2', 'olymp_tree_ms', 1500],
    [11, 'srv1', 'olymp_tree_ms', 1600],
  ];
  for (const [sec, target, metric, ms] of runRows) {
    metricsLines.push(metricLine(tsAt(sec), target, metric, ms, RUN));
  }
  metricsLines.push(metricLine(tsAt(600), 'srv1', 'login_ms', 999, RECHECK));

  fs.writeFileSync(path.join(dir, 'metrics.csv'), [METRICS_HEADER, ...metricsLines].join('\n') + '\n', 'utf-8');
  const runsLines = [runsLine(OLD_RUN, '2026-01-01T09:00:00.000Z')];
  if (withRunsRow) {
    runsLines.push(runsLine(RUN, START));
  }
  fs.writeFileSync(path.join(dir, 'runs.csv'), [RUNS_HEADER, ...runsLines].join('\n') + '\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'last-run-id.txt'), RUN + '\n', 'utf-8');
  return { dir, metricsLines };
}

function runReport(dir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('MONITOR_')) {
      delete env[key];
    }
  }
  env.MONITOR_ARTIFACTS = dir;
  // Несуществующий конфиг: тест не зависит от env.json разработчика.
  env.MONITOR_CONFIG = path.join(dir, 'env.json');
  const res = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf-8' });
  const reportPath = path.join(dir, 'report.txt');
  return { res, text: fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf-8') : '' };
}

test('report: metrics.csv читается с точки входа по started_at прогона', () => {
  const { dir } = buildFixture('tail', { withRunsRow: true });
  const { res, text } = runReport(dir);

  expect(res.error, res.stderr).toBeUndefined();
  // Оба узла прогона на месте, включая строки, записанные вперемешку.
  expect(text).toContain('Узел srv1');
  expect(text).toContain('Узел srv2');
  expect(text).toContain('1.10 с'); // srv1 signin_page_ms
  expect(text).toContain('1.50 с'); // srv2 olymp_tree_ms
  // Строка прогона RUN с меткой до его старта в файле есть, но до точки входа не дочитывается.
  expect(text).not.toContain('Узел ghost');
  // Перепроверка прогона найдена в хвосте.
  expect(text).toContain(`Перепроверка (прогон ${RECHECK}`);
  expect(text).toContain('Параметры прогона:');
  // Шапка параметров: сценарий, без режимных флагов.
  expect(text).toContain('сценарий: cabinet');
});

test('report: нет строки прогона в runs.csv — metrics.csv читается целиком', () => {
  const { dir } = buildFixture('whole', { withRunsRow: false });
  const { res, text } = runReport(dir);

  expect(res.error, res.stderr).toBeUndefined();
  expect(text).toContain('Узел ghost');
  expect(text).toContain('Узел srv1');
  expect(text).toContain('Узел srv2');
  expect(text).toContain('нет строки этого прогона');
});

test('report: started_at не в формате toISOString — metrics.csv читается целиком', () => {
  const { dir } = buildFixture('bad-started-at', { withRunsRow: true });
  const runsPath = path.join(dir, 'runs.csv');
  fs.writeFileSync(runsPath, fs.readFileSync(runsPath, 'utf-8').replace(START, '29.09.2026 12:00:00'), 'utf-8');
  const { res, text } = runReport(dir);

  expect(res.error, res.stderr).toBeUndefined();
  expect(text).toContain('Узел ghost');
  expect(text).toContain('Узел srv2');
});

test('report: подписи метрик — из вложения timings сценария, без подписи — сырое имя', () => {
  const { dir } = buildFixture('metric-labels', { withRunsRow: true });
  // Метрика с подписью сценария и метрика без: подписанная показывается по-человечески,
  // неподписанная — под сырым именем.
  const csvPath = path.join(dir, 'metrics.csv');
  fs.appendFileSync(
    csvPath,
    [
      metricLine(tsAt(20), 'srv1', 'signin_page_ms', 900, RUN),
      metricLine(tsAt(21), 'srv1', 'custom_metric', 900, RUN),
    ].join('\n') + '\n',
    'utf-8'
  );
  const timings = Buffer.from(
    JSON.stringify({
      labels: { signin_page_ms: 'Страница входа', custom_metric: 'Моя метрика' },
      title: 'Мониторинг тестового кабинета',
      legend: ['Моя метрика — расшифровка шага.'],
    }),
    'utf-8'
  ).toString('base64');
  const json = {
    config: { metadata: { run_id: RUN }, projects: [{ name: 'srv1' }, { name: 'srv2' }] },
    suites: [
      {
        specs: [
          {
            title: 'сценарий',
            tests: [{ projectName: 'srv1', results: [{ status: 'passed', attachments: [{ name: 'timings', body: timings, contentType: 'application/json' }] }] }],
          },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'last-run.json'), JSON.stringify(json), 'utf-8');
  const { res, text } = runReport(dir);

  expect(res.error, res.stderr).toBeUndefined();
  expect(res.status, res.stdout + res.stderr).toBe(0);
  expect(text).toContain('Страница входа');
  expect(text).toContain('Моя метрика');
  // Заголовок и легенда — из вложения сценария.
  expect(text).toContain('Мониторинг тестового кабинета — НОРМА');
  expect(text).toContain('Моя метрика — расшифровка шага.');

  // Без вложения timings подписей нет — сырое имя метрики, нейтральный заголовок, без легенды.
  const { dir: dir2 } = buildFixture('metric-labels-fallback', { withRunsRow: true });
  fs.appendFileSync(path.join(dir2, 'metrics.csv'), metricLine(tsAt(20), 'srv1', 'custom_metric', 900, RUN) + '\n', 'utf-8');
  fs.writeFileSync(
    path.join(dir2, 'last-run.json'),
    JSON.stringify({ config: { metadata: { run_id: RUN }, projects: [{ name: 'srv1' }] }, suites: [] }),
    'utf-8'
  );
  const second = runReport(dir2);
  expect(second.res.status, second.res.stdout + second.res.stderr).toBe(0);
  expect(second.text).toContain('custom_metric');
  expect(second.text).not.toContain('Моя метрика');
  expect(second.text).toContain('Мониторинг веб-кабинета — НОРМА');
  expect(second.text).not.toContain('расшифровка шага');
});

// --- шапка metrics.csv между замерами --------------------------------------

/**
 * Импорт `helpers/metrics.ts` с очищенными MONITOR_*: модуль читает среду при импорте,
 * а окружение тестовой оболочки не должно на него влиять.
 */
async function importMetricsCleanEnv() {
  const saved: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('MONITOR_')) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    return await import('../helpers/metrics');
  } finally {
    Object.assign(process.env, saved);
  }
}

test('report: metrics.csv удалён между замерами — шапка восстанавливается, отчёт не падает', async () => {
  const metrics = await importMetricsCleanEnv();
  const dir = path.join(CASES_ROOT, 'csv-restored');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Прогон до удаления: шапка и строка на месте.
  const csvPath = path.join(dir, 'metrics.csv');
  metrics.ensureCsvFileHeader(csvPath, METRICS_HEADER);
  fs.appendFileSync(csvPath, metricLine(tsAt(1), 'srv1', 'login_ms', 700, RUN) + '\n', 'utf-8');
  // Файл снесли между замерами — следующий прогон ставит шапку заново (ensureCsvHeader
  // в globalSetup), дубля не будет.
  fs.rmSync(csvPath);
  metrics.ensureCsvFileHeader(csvPath, METRICS_HEADER);
  metrics.ensureCsvFileHeader(csvPath, METRICS_HEADER);
  expect(fs.readFileSync(csvPath, 'utf-8')).toBe(METRICS_HEADER + '\n');

  // Замеры восстановленного прогона и отчёт по ним строится.
  fs.appendFileSync(
    csvPath,
    [
      metricLine(tsAt(2), 'srv1', 'signin_page_ms', 600, RUN),
      metricLine(tsAt(3), 'srv1', 'login_ms', 700, RUN),
      metricLine(tsAt(4), 'srv1', 'olymp_tree_ms', 800, RUN),
    ].join('\n') + '\n',
    'utf-8'
  );
  fs.writeFileSync(path.join(dir, 'runs.csv'), [RUNS_HEADER, runsLine(RUN, START)].join('\n') + '\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'last-run-id.txt'), RUN + '\n', 'utf-8');

  const { res, text } = runReport(dir);
  expect(res.error, res.stderr).toBeUndefined();
  expect(res.status, res.stdout + res.stderr).toBe(0);
  expect(text).toContain('Узел srv1');
});

// --- валидация ключа scenario ----------------------------------------------

/**
 * Чистая валидация конфига — `loadMonitorConfig` оркестратора (scripts/monitor.mjs,
 * импорт без побочных эффектов: main-охрана не пропускает авто-запуск).
 */
async function importMonitor() {
  return import(pathToFileURL(path.join(BUNDLE_ROOT, 'scripts', 'monitor.mjs')).href);
}

function writeConfig(name: string, cfg: Record<string, unknown>): string {
  const dir = path.join(CASES_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'env.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
  return configPath;
}

const VALID_BASE = {
  environment: 'test',
  login: 'login',
  password: 'password',
  scenario: 'olymp-first-round',
  targets: { srv1: 'http://srv1.invalid/school.html' },
  thresholds: { signin_page_ms: { reference: 1000, maxRatio: 2 } },
};

test('config: ключ scenario обязателен — без него ошибка с именем поля', async () => {
  const withoutScenario = { ...VALID_BASE } as Record<string, unknown>;
  delete withoutScenario.scenario;
  const configPath = writeConfig('config-no-scenario', withoutScenario);
  const { loadMonitorConfig } = await importMonitor();
  expect(() => loadMonitorConfig(configPath)).toThrow(/scenario/);
});

test('config: сценарий задан — конфиг загружается', async () => {
  const configPath = writeConfig('config-with-scenario', VALID_BASE);
  const { loadMonitorConfig } = await importMonitor();
  const cfg = loadMonitorConfig(configPath) as { scenario: string };
  expect(cfg.scenario).toBe('olymp-first-round');
});

test('config: файл сценария не найден — ошибка до прогона, с именем файла', async () => {
  const configPath = writeConfig('config-missing-scenario-file', { ...VALID_BASE, scenario: 'no-such-scenario' });
  const { loadMonitorConfig } = await importMonitor();
  expect(() => loadMonitorConfig(configPath)).toThrow(/specs\/no-such-scenario\.spec\.ts/);
});

test('config: порог метрики сценария не задан — ошибка с именем метрики', async () => {
  // Тот же контракт, что проверяет спека при загрузке модуля (thresholdsFor в specs/cabinet.ts):
  // сверяется здесь напрямую, без прогона.
  const saved: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('MONITOR_')) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    const cabinet = await import('../specs/cabinet');
    const cfg = { ...VALID_BASE } as Parameters<typeof cabinet.thresholdsFor>[0];
    // В фикстине только signin_page_ms: первая же отсутствующая метрика — login_ms.
    expect(() => cabinet.thresholdsFor(cfg, ['signin_page_ms', 'login_ms', 'olymp_tree_ms'])).toThrow(
      /thresholds\.login_ms/
    );
    const full = {
      ...VALID_BASE,
      thresholds: {
        signin_page_ms: { reference: 1000, maxRatio: 2 },
        login_ms: { reference: 1000, maxRatio: 10 },
        olymp_tree_ms: { reference: 1000, maxRatio: 5 },
      },
    } as Parameters<typeof cabinet.thresholdsFor>[0];
    const thresholds = cabinet.thresholdsFor(full);
    expect(thresholds.olymp_tree_ms.reference).toBe(1000);
  } finally {
    Object.assign(process.env, saved);
  }
});

// --- состав архива прогона: снимки --------------------------------------------

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface ArchiveOptions {
  /** Принят ли last-run.json прогона: без него HTML-отчёт `report/` в архив не пакуется. */
  acceptedRunJson: boolean;
  /** Принят ли last-run-recheck.json: без него `report-recheck/` в архив не пакуется. */
  acceptedRecheckJson?: boolean;
  /** Файлы `report/data/` (имя → байты); `report/` на диске есть всегда. */
  reportData?: Record<string, Buffer>;
  /** Файлы `report-recheck/data/`; `undefined` — каталога перепроверки на диске нет. */
  recheckData?: Record<string, Buffer>;
  /** Снимки прогона в `screenshots/` (имя → байты). */
  shots: Record<string, Buffer>;
}

function writeReportDir(root: string, data: Record<string, Buffer>): void {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>', 'utf-8');
  for (const [name, bytes] of Object.entries(data)) {
    fs.writeFileSync(path.join(root, 'data', name), bytes);
  }
}

/** Фикстура прогона с HTML-отчётом и снимками; возвращает исходные байты снимков. */
function buildArchiveFixture(name: string, opts: ArchiveOptions): { dir: string; originals: Map<string, Buffer> } {
  const { dir } = buildFixture(name, { withRunsRow: true });
  if (opts.acceptedRunJson) {
    const json = { config: { metadata: { run_id: RUN }, projects: [{ name: 'srv1' }, { name: 'srv2' }] }, suites: [] };
    fs.writeFileSync(path.join(dir, 'last-run.json'), JSON.stringify(json), 'utf-8');
  }
  if (opts.acceptedRecheckJson) {
    const json = { config: { metadata: { recheck_of: RUN }, projects: [{ name: 'srv1' }] }, suites: [] };
    fs.writeFileSync(path.join(dir, 'last-run-recheck.json'), JSON.stringify(json), 'utf-8');
  }
  writeReportDir(path.join(dir, 'report'), opts.reportData ?? {});
  if (opts.recheckData !== undefined) {
    writeReportDir(path.join(dir, 'report-recheck'), opts.recheckData);
  }
  const shotsDir = path.join(dir, 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const originals = new Map<string, Buffer>();
  for (const [shotName, bytes] of Object.entries(opts.shots)) {
    fs.writeFileSync(path.join(shotsDir, shotName), bytes);
    originals.set(shotName, bytes);
  }
  return { dir, originals };
}

/** Распаковка `report_<RUN>.zip` в свежий `<dir>/unzipped` настоящим .NET. */
function unzipArchive(dir: string): string {
  const zip = path.join(dir, `report_${RUN}.zip`);
  const dest = path.join(dir, 'unzipped');
  expect(fs.existsSync(zip), `архив ${zip} не собран`).toBe(true);
  fs.rmSync(dest, { recursive: true, force: true });
  const script =
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    `[System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zip)}, ${psQuote(dest)})`;
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8' });
  expect(res.status, res.stderr).toBe(0);
  return dest;
}

function rootPngs(unzipped: string): string[] {
  return fs.readdirSync(unzipped).filter(n => n.endsWith('.png'));
}

/**
 * Ни один снимок не потерян: каждый лежит в архиве под `screenshots/<имя>` с исходными
 * байтами; с диска снимки прогона удалены после упаковки.
 */
function expectShotsPacked(dir: string, unzipped: string, originals: Map<string, Buffer>): void {
  for (const [name, bytes] of originals) {
    const packed = path.join(unzipped, 'screenshots', name);
    expect(fs.existsSync(packed), `снимок ${name} не упакован под screenshots/`).toBe(true);
    expect(fs.readFileSync(packed).equals(bytes), `снимок ${name} в архиве отличается от оригинала`).toBe(true);
  }
  const left = fs.readdirSync(path.join(dir, 'screenshots')).filter(n => n.startsWith(`${RUN}-`));
  expect(left, 'снимки прогона остались на диске').toEqual([]);
}

test.describe('report: снимки в архиве прогона', () => {
  test('снимки этого прогона — под screenshots/, чужой остаток в каталоге не попадает в архив', () => {
    const x = Buffer.from('shot-X');
    const y = Buffer.from('shot-Y');
    const shot1 = `${RUN}-srv1-r0-pass.png`;
    const shot2 = `${RUN}-srv2-r0-fail.png`;
    const { dir, originals } = buildArchiveFixture('shots-packed', {
      acceptedRunJson: true,
      reportData: { 'entry1.png': x },
      shots: { [shot1]: x, [shot2]: y },
    });
    // Остаток чужого прогона: его архив не пересобирался, снимок остался в общем каталоге.
    // Упаковка каталогом целиком утянула бы его в этот архив — списком не должен.
    const foreign = '20990101-000000-1-srv9-r0-pass.png';
    fs.writeFileSync(path.join(dir, 'screenshots', foreign), 'foreign', 'utf-8');
    const res = runReport(dir).res;

    expect(res.error, res.stderr).toBeUndefined();
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain('(снимков: 2)');
    const unzipped = unzipArchive(dir);
    expect(rootPngs(unzipped)).toEqual([]);
    expect(fs.existsSync(path.join(unzipped, 'report', 'data', 'entry1.png'))).toBe(true);
    expectShotsPacked(dir, unzipped, originals);
    expect(fs.existsSync(path.join(unzipped, 'screenshots', foreign))).toBe(false);
    // Чужой снимок на диске не тронут: он чужого прогона.
    expect(fs.existsSync(path.join(dir, 'screenshots', foreign))).toBe(true);
  });

  test('HTML-отчёт не принят — снимки всё равно в архиве под screenshots/', () => {
    const x = Buffer.from('shot-X');
    const shot1 = `${RUN}-srv1-r0-pass.png`;
    // report/ с файлами на диске есть, но last-run.json не принят — каталог не пакуется.
    const { dir, originals } = buildArchiveFixture('shots-report-not-packed', {
      acceptedRunJson: false,
      reportData: { 'entry1.png': x },
      shots: { [shot1]: x },
    });
    const res = runReport(dir).res;

    expect(res.error, res.stderr).toBeUndefined();
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain('(снимков: 1)');
    const unzipped = unzipArchive(dir);
    expect(rootPngs(unzipped)).toEqual([]);
    expect(fs.existsSync(path.join(unzipped, 'report'))).toBe(false);
    expect(fs.existsSync(path.join(unzipped, 'screenshots'))).toBe(true);
    expectShotsPacked(dir, unzipped, originals);
  });

  test('снимки перепроверки — в том же каталоге screenshots/ архива', () => {
    const z = Buffer.from('shot-Z');
    const shot = `${RECHECK}-srv1-r0-pass.png`;
    const { dir, originals } = buildArchiveFixture('shots-recheck', {
      acceptedRunJson: true,
      acceptedRecheckJson: true,
      recheckData: { 'entry2.png': z },
      shots: { [shot]: z },
    });
    const res = runReport(dir).res;

    expect(res.error, res.stderr).toBeUndefined();
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const unzipped = unzipArchive(dir);
    expect(fs.existsSync(path.join(unzipped, 'report-recheck', 'data', 'entry2.png'))).toBe(true);
    expectShotsPacked(dir, unzipped, originals);
  });

  test('перепроверка не принята — её каталог не упакован, снимок в screenshots/ архива', () => {
    const z = Buffer.from('shot-Z');
    const shot = `${RECHECK}-srv1-r0-pass.png`;
    const { dir, originals } = buildArchiveFixture('shots-recheck-not-accepted', {
      acceptedRunJson: true,
      acceptedRecheckJson: false,
      recheckData: { 'entry2.png': z },
      shots: { [shot]: z },
    });
    const res = runReport(dir).res;

    expect(res.error, res.stderr).toBeUndefined();
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const unzipped = unzipArchive(dir);
    expect(fs.existsSync(path.join(unzipped, 'report-recheck'))).toBe(false);
    expectShotsPacked(dir, unzipped, originals);
  });

  test('снимков нет — каталога screenshots/ в архиве нет', () => {
    const { dir } = buildArchiveFixture('shots-none', {
      acceptedRunJson: true,
      shots: {},
    });
    const res = runReport(dir).res;

    expect(res.error, res.stderr).toBeUndefined();
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain('(снимков: 0)');
    const unzipped = unzipArchive(dir);
    expect(fs.existsSync(path.join(unzipped, 'screenshots'))).toBe(false);
  });
});
