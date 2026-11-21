/**
 * `runs.csv`: строка параметров на каждый прогон (у перепроверки непуст `recheck_of`),
 * соединяется с `metrics.csv` по `run_id`. Логин, пароль и адреса узлов не пишутся.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { FullConfig } from '@playwright/test/reporter';
import * as os from 'os';
import { ensureCsvFileHeader, csvCell } from './metrics';
import {
  ARTIFACTS_DIR,
  BUNDLE_ROOT,
  CONFIG_PATH,
  RECHECK_OF,
  TIMEOUTS,
  TIMEOUTS_MODE,
  loadConfig
} from './config';

export const RUNS_CSV_PATH = path.join(ARTIFACTS_DIR, 'runs.csv');

export const RUNS_CSV_HEADER = [
  'run_id',
  'started_at',
  'config_file',
  'environment',
  'host',
  'cpu_count',
  'workers',
  'targets',
  'scenario',
  'recheck_of',
  'timeouts',
  'node_version',
  'playwright_version',
  'bundle_version'
].join(',');

function bundleVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE_ROOT, 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return pkg.version || '';
  } catch {
    return '';
  }
}

/** Дописывает строку в `runs.csv`; `targets` — реально идущие узлы (с учётом `--project`). */
export function recordRun(config: FullConfig, runIdValue: string, targets: string[]): void {
  ensureCsvFileHeader(RUNS_CSV_PATH, RUNS_CSV_HEADER);

  const cfg = loadConfig();
  const timeouts = `${TIMEOUTS_MODE}:${TIMEOUTS.stepMs}/${TIMEOUTS.testMs}/${TIMEOUTS.actionMs}/${TIMEOUTS.navigationMs}`;

  const cells = [
    runIdValue,
    new Date().toISOString(),
    path.relative(BUNDLE_ROOT, CONFIG_PATH),
    cfg.environment,
    os.hostname(),
    String(os.cpus().length),
    String(config.workers),
    targets.join(';'),
    cfg.scenario,
    RECHECK_OF,
    timeouts,
    process.version,
    config.version,
    bundleVersion()
  ].map(csvCell);

  fs.appendFileSync(RUNS_CSV_PATH, cells.join(',') + '\n', 'utf-8');
}
