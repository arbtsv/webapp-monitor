/**
 * Конфигурация прогона. Один файл — один контур (dev или прод): `MONITOR_CONFIG`,
 * по умолчанию `env.json` рядом с бандлом. `targets` — узлы за балансировщиком под
 * одной учётной записью; `MONITOR_TARGET` сужает набор. Пороги статические.
 * Сезонные режимы — контент сценария (specs/<scenario>.spec.ts), не ветка ядра.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface Threshold {
  /** Эталонное время, мс. */
  reference: number;
  /** Во сколько раз замер может превысить эталон, прежде чем тест упадёт. */
  maxRatio: number;
}

export interface MonitorConfig {
  /** Имя контура — попадает в CSV и в отчёт. */
  environment: string;
  login: string;
  password: string;
  /** Имя файла сценария без расширения (`specs/<scenario>.spec.ts`). */
  scenario: string;
  targets: Record<string, string>;
  /** Эталоны по именам метрик: какие имена объявляет сценарий, ядро не знает. */
  thresholds: Record<string, Threshold>;
}

export interface ResolvedTarget {
  name: string;
  url: string;
}

/**
 * По умолчанию таймауты короткие: шаг, не уложившийся в `stepMs`, — сигнал, и замер
 * такого шага не пишется. `MONITOR_TIMEOUTS=debug` — повышенные, для разбора, когда
 * нужна реальная цифра. Порог выше `stepMs` в режиме по умолчанию недостижим.
 */
export interface Timeouts {
  /** Ожидание одного шага сценария. */
  stepMs: number;
  /** Весь тест целиком. */
  testMs: number;
  /** Любое действие Playwright без своего таймаута. */
  actionMs: number;
  /** Навигация `page.goto`. */
  navigationMs: number;
}

const DEFAULT_TIMEOUTS: Timeouts = { stepMs: 30_000, testMs: 180_000, actionMs: 30_000, navigationMs: 60_000 };
const DEBUG_TIMEOUTS: Timeouts = { stepMs: 180_000, testMs: 900_000, actionMs: 180_000, navigationMs: 180_000 };

export type TimeoutsMode = 'default' | 'debug';

function resolveTimeoutsMode(): TimeoutsMode {
  const mode = process.env.MONITOR_TIMEOUTS?.trim().toLowerCase();
  if (!mode) {
    return 'default';
  }
  if (mode === 'debug') {
    return 'debug';
  }
  throw new Error(`MONITOR_TIMEOUTS="${mode}" не распознан. Допустимо: не задано (по умолчанию) или debug`);
}

/** Режим таймаутов — тем же значением, что пишется в `runs.csv`. */
export const TIMEOUTS_MODE: TimeoutsMode = resolveTimeoutsMode();

export const TIMEOUTS: Timeouts = TIMEOUTS_MODE === 'debug' ? DEBUG_TIMEOUTS : DEFAULT_TIMEOUTS;

export const BUNDLE_ROOT = path.resolve(__dirname, '..');

export const CONFIG_PATH = path.resolve(BUNDLE_ROOT, process.env.MONITOR_CONFIG?.trim() || 'env.json');

export const ARTIFACTS_DIR = path.resolve(BUNDLE_ROOT, process.env.MONITOR_ARTIFACTS?.trim() || 'artifacts');

/** `MONITOR_RECHECK_OF=<run_id>` (ставит оркестратор): прогон — перепроверка медленных узлов этого run_id. */
export const RECHECK_OF = process.env.MONITOR_RECHECK_OF?.trim() || '';

export function loadConfig(): MonitorConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `${CONFIG_PATH} не найден. Скопируйте env.example.json в env.json (или в env.<контур>.json ` +
        `и укажите его через MONITOR_CONFIG) и заполните.`
    );
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as MonitorConfig;

  if (!cfg.environment) {
    throw new Error(`${CONFIG_PATH}: не задан environment — имя контура, под которым пишется статистика`);
  }
  if (!cfg.login || !cfg.password) {
    throw new Error(`${CONFIG_PATH}: не заполнены login/password`);
  }
  if (!cfg.scenario || typeof cfg.scenario !== 'string' || cfg.scenario.trim() === '') {
    throw new Error(`${CONFIG_PATH}: не задан scenario — имя файла сценария без расширения (specs/<scenario>.spec.ts)`);
  }
  if (!cfg.targets || Object.keys(cfg.targets).length === 0) {
    throw new Error(`${CONFIG_PATH}: не задан ни один узел в targets`);
  }

  // Полноту порогов по именам метрик сверяет сценарий при загрузке (specs/cabinet.ts):
  // ядро знает имена метрик как произвольные строки. Здесь — сама таблица порогов.
  if (!cfg.thresholds || typeof cfg.thresholds !== 'object' || Object.keys(cfg.thresholds).length === 0) {
    throw new Error(`${CONFIG_PATH}: не заданы thresholds — для каждой метрики сценария нужен порог { reference, maxRatio }`);
  }
  for (const metric of Object.keys(cfg.thresholds)) {
    const t = cfg.thresholds[metric];
    if (!t || typeof t !== 'object') {
      throw new Error(`${CONFIG_PATH}: thresholds.${metric} должен быть объектом { reference, maxRatio }`);
    }
    assertPositive(t.reference, `thresholds.${metric}.reference`);
    assertPositive(t.maxRatio, `thresholds.${metric}.maxRatio`);
  }

  return cfg;
}

/**
 * Узлы, по которым идёт этот прогон: по умолчанию все из конфига, иначе
 * перечисленные в `MONITOR_TARGET` через запятую. Неизвестное имя — жёсткая
 * ошибка со списком известных, а не молчаливый откат к полному набору.
 */
export function resolveTargets(cfg: MonitorConfig): ResolvedTarget[] {
  const all = Object.entries(cfg.targets).map(([name, url]) => ({ name, url }));

  const requested = process.env.MONITOR_TARGET?.trim();
  if (!requested) {
    return all;
  }

  const wanted = requested
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const picked = wanted.map(name => {
    const found = all.find(t => t.name === name);
    if (!found) {
      throw new Error(
        `Узел "${name}" не найден в ${CONFIG_PATH} → targets. Известные: ${all.map(t => t.name).join(', ')}`
      );
    }
    return found;
  });

  if (picked.length === 0) {
    throw new Error('MONITOR_TARGET задан, но не назвал ни одного узла');
  }
  return picked;
}

function assertPositive(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${CONFIG_PATH}: ${field} должно быть положительным числом, получено ${JSON.stringify(value)}`);
  }
}
