/**
 * Замеры: строка в накопительный `metrics.csv` (только дописывается) на каждый замер
 * и сверка со статическим эталоном из конфига.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ARTIFACTS_DIR, type Threshold } from './config';

export type Verdict = 'ok' | 'slow';

export interface MetricResult {
  /** Имя метрики — произвольная строка, которую объявляет сценарий. */
  metric: string;
  durationMs: number;
  referenceMs: number;
  maxRatio: number;
  ratio: number;
  verdict: Verdict;
  /** Готовое сообщение для ассерта, либо '' — когда замер в норме. */
  failure: string;
}

export const CSV_PATH = process.env.MONITOR_CSV?.trim() || path.join(ARTIFACTS_DIR, 'metrics.csv');

export const CSV_HEADER =
  'timestamp,environment,target,url,metric,duration_ms,reference_ms,ratio,max_ratio,verdict,run_id';

export interface MetricContext {
  environment: string;
  target: string;
  url: string;
  runId: string;
}

export function recordMetric(
  ctx: MetricContext,
  metric: string,
  durationMs: number,
  threshold: Threshold
): MetricResult {
  const ratio = round2(durationMs / threshold.reference);
  const verdict: Verdict = ratio > threshold.maxRatio ? 'slow' : 'ok';

  const failure =
    verdict === 'slow'
      ? `Замер "${metric}" = ${seconds(durationMs)} с против эталона ${seconds(threshold.reference)} с ` +
        `(в ${ratio} раза, порог ${threshold.maxRatio}). Контур: ${ctx.environment}, узел: ${ctx.target}.`
      : '';

  appendCsv([
    new Date().toISOString(),
    csvCell(ctx.environment),
    csvCell(ctx.target),
    csvCell(ctx.url),
    metric,
    String(durationMs),
    String(threshold.reference),
    String(ratio),
    String(threshold.maxRatio),
    verdict,
    ctx.runId,
  ]);

  return { metric, durationMs, referenceMs: threshold.reference, maxRatio: threshold.maxRatio, ratio, verdict, failure };
}

/**
 * Создаёт файл с шапкой, если его нет. Флаг `wx` (O_EXCL) исключает дубль шапки при
 * параллельных вызовах; пустой существующий файл получает шапку обычной записью.
 */
export function ensureCsvFileHeader(filePath: string, header: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, header + '\n', { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw e;
    }
    if (fs.statSync(filePath).size === 0) {
      fs.writeFileSync(filePath, header + '\n', 'utf-8');
    }
  }
}

export function ensureCsvHeader(): void {
  ensureCsvFileHeader(CSV_PATH, CSV_HEADER);
}

/**
 * Только дописывает строку: шапку кладёт `ensureCsvHeader()` в globalSetup. Файла нет
 * (удалён посреди прогона, спека запущена мимо globalSetup) — шапка и строка одной
 * записью с флагом `ax` (O_EXCL); при `EEXIST` — обычное дописывание.
 */
function appendCsv(cells: string[]): void {
  const line = cells.join(',') + '\n';
  try {
    fs.appendFileSync(CSV_PATH, line, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
    fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
    try {
      fs.writeFileSync(CSV_PATH, CSV_HEADER + '\n' + line, { flag: 'ax' });
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw e2;
      }
      fs.appendFileSync(CSV_PATH, line, 'utf-8');
    }
  }
}

/** Экранирование CSV-ячейки — общее для metrics.csv и runs.csv. */
export function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Секунды с двумя знаками — только для текста сообщений; CSV и пороги остаются в мс. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export const RUN_ID_PATH = path.join(ARTIFACTS_DIR, 'last-run-id.txt');

/**
 * Пишет id прогона в `RUN_ID_PATH` для `scripts/report.mjs`; вызывается только из
 * globalSetup. Через временный файл и `rename` — чтобы читатель не поймал пустой файл.
 * На Windows `rename` поверх файла, открытого другим процессом, бросает EPERM/EBUSY —
 * тогда прямая запись: прогон важнее атомарности.
 */
export function writeRunIdFile(id: string): void {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const tmpPath = `${RUN_ID_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, id + '\n', 'utf-8');
    fs.renameSync(tmpPath, RUN_ID_PATH);
  } catch {
    fs.rmSync(tmpPath, { force: true });
    fs.writeFileSync(RUN_ID_PATH, id + '\n', 'utf-8');
  }
}

/**
 * run_id прогона — из `MONITOR_RUN_ID`, который globalSetup выставляет до старта
 * воркеров. Не из `last-run-id.txt`: параллельный запуск перезаписал бы файл, и замеры
 * уехали бы под чужой id.
 */
export function runId(): string {
  const existing = process.env.MONITOR_RUN_ID?.trim();
  if (existing) {
    return existing;
  }

  // Спека загружена мимо globalSetup (`--list`, отладчик): одноразовый id. Файл id не
  // читается (подхватил бы старый прогон) и не пишется (затёр бы последний настоящий).
  // eslint-disable-next-line no-console
  console.warn(
    '[webapp-monitor] runId(): MONITOR_RUN_ID не задан — генерирую одноразовый id ' +
      'вместо общего (globalSetup не выполнялся: `playwright test --list`, ' +
      'отладчик или запуск мимо `npm run monitor`)'
  );
  return generateRunId();
}

/**
 * `YYYYMMDD-HHMMSS-<pid>`. PID различает два независимых запуска, стартовавших в одну
 * секунду, — иначе их строки CSV и снимки слились бы.
 */
export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${process.pid}`
  );
}
