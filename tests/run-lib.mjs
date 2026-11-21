/**
 * Общий хелпер обёрток `run-smoke.mjs` и `run-fake.mjs`: запуск дочернего Node-процесса без
 * оболочки с перехватом вывода и решение «исход ожидаемый» по коду возврата и строке итога.
 * Это библиотека: при импорте модуль ничего не запускает. Последовательность шагов держит
 * каждая обёртка сама.
 *
 * Вывод дочернего процесса доходит до консоли без изменений — хелпер лишь копит его, чтобы
 * найти строку итога. Файлов отчёта он не читает.
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

/** Корень бандла — на уровень выше каталога `tests`. */
export const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Код сбоя самой обёртки — отличим от кодов проверок (0, 1). */
export const HARNESS_FAILURE = 2;

/** Строка вердикта, которой `report.mjs` и `monitor.bat` отмечают проваленный набор. */
export const FAIL_VERDICT_LINE = 'ИТОГ: ПРОВАЛ';

/**
 * Целая строка вывода, равная `FAIL_VERDICT_LINE` (с необязательным CR перед концом строки).
 * Флаг только `m`: с `g` метод `test` запоминал бы `lastIndex` между вызовами.
 */
export const FAIL_VERDICT = new RegExp(`^${FAIL_VERDICT_LINE}\\r?$`, 'm');

/**
 * Копия `process.env` без переменных `MONITOR_*` оболочки: оставшийся `MONITOR_CONFIG` или
 * `MONITOR_CSV` увёл бы дочерний процесс в рабочий конфиг или рабочую историю замеров.
 * Копия `process.env` — обычный объект, поэтому имена сравниваются без учёта регистра вручную.
 * Нужные дочернему процессу `MONITOR_*` вызывающий добавляет сам.
 */
export function envWithoutMonitor() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('MONITOR_')) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * Запустить Node с аргументами `args` в корне бандла. Оболочки нет, строка команды не
 * собирается: аргументы идут массивом. Вывод пробрасывается на консоль теми же буферами
 * (без перекодирования, многобайтовая кириллица не рвётся на границах чанков) и копится;
 * декодируется один раз по `close`, когда оба потока дочитаны.
 * Не запустившийся процесс — reject; иначе `{ code, signal, text }` (`code === null` —
 * процесс завершён извне).
 */
export function runCaptured(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: BUNDLE_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks = [];
    child.stdout.on('data', chunk => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', chunk => {
      chunks.push(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, text: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/**
 * `null`, если исход ожидаемый, иначе причина одной строкой.
 * `expected = { code, marker?, markers?, absent? }`: исход зелёный только когда код равен
 * ожидаемому, все `markers` (или одиночный `marker`) найдены в выводе и ни один `absent`
 * не найден. Регэкспы без флага `g`.
 */
export function mismatch(result, expected) {
  if (result.code === null) {
    return `завершён извне (${result.signal})`;
  }
  if (result.code !== expected.code) {
    return `получен код ${result.code}`;
  }
  const markers = expected.markers ?? (expected.marker ? [expected.marker] : []);
  for (const m of markers) {
    if (!m.test(result.text)) {
      return `нет строки, удовлетворяющей ${m}`;
    }
  }
  for (const m of expected.absent ?? []) {
    if (m.test(result.text)) {
      return `есть строка, запрещённая проверкой ${m}`;
    }
  }
  return null;
}

/** Описание ожидания для сообщения: «код 1», «код 1 и 3 маркера» и т.п. */
function describeExpected(expected) {
  const markers = expected.markers ?? (expected.marker ? [expected.marker] : []);
  const absent = expected.absent ?? [];
  const parts = [`код ${expected.code}`];
  if (markers.length > 0) {
    parts.push(`${markers.length} маркера`);
  }
  if (absent.length > 0) {
    parts.push(`${absent.length} запрещённых строк`);
  }
  return parts.join(', ');
}

/**
 * Один шаг обёртки → код, которым обёртке выходить: 0 — исход ожидаемый, 1 — неожиданный
 * (одна строка с причиной в stderr), `HARNESS_FAILURE` — процесс не запустился.
 */
export async function runStep(prefix, label, args, env, expected) {
  let result;
  try {
    result = await runCaptured(args, env);
  } catch (e) {
    console.error(`${prefix} ${label}: не запустился: ${e.message}`);
    return HARNESS_FAILURE;
  }
  const reason = mismatch(result, expected);
  if (reason === null) {
    return 0;
  }
  console.error(`${prefix} ${label}: ожидался ${describeExpected(expected)}, ${reason}`);
  return 1;
}
