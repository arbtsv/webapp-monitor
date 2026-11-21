/**
 * Пути артефактов, `sanitize`, чтение id прогона и CSV для скриптов `scripts/*.mjs`.
 * Скрипты работают без сборки TypeScript, поэтому константы повторяют `helpers/*.ts`
 * и `playwright.config.ts` — при правке менять в обоих местах.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARTIFACTS_DIR = path.resolve(BUNDLE_ROOT, process.env.MONITOR_ARTIFACTS?.trim() || 'artifacts');

export const CSV_PATH = process.env.MONITOR_CSV?.trim() || path.join(ARTIFACTS_DIR, 'metrics.csv');
export const RUN_ID_PATH = path.join(ARTIFACTS_DIR, 'last-run-id.txt');
export const LAST_RUN_JSON = path.join(ARTIFACTS_DIR, 'last-run.json');
// Как RUNS_CSV_PATH в helpers/runs.ts.
export const RUNS_CSV_PATH = path.join(ARTIFACTS_DIR, 'runs.csv');
// run.json в архиве прогона — строки runs.csv этого прогона.
export const RUN_JSON = path.join(ARTIFACTS_DIR, 'run.json');
export const REPORT_DIR = path.join(ARTIFACTS_DIR, 'report');
export const SCREENSHOT_DIR = path.join(ARTIFACTS_DIR, 'screenshots');
export const REPORT_TXT = path.join(ARTIFACTS_DIR, 'report.txt');
// Копия архива последнего прогона под постоянным именем.
export const REPORT_ZIP = path.join(ARTIFACTS_DIR, 'report.zip');

/** Архив истории прогона — `report_<run_id>.zip`. */
export function runReportZipPath(runIdValue) {
  return path.join(ARTIFACTS_DIR, `report_${sanitize(runIdValue)}.zip`);
}

// Перепроверка: суффикс run_id и отдельные выходы — как в playwright.config.ts.
export const RECHECK_SUFFIX = '-recheck';
export const LAST_RUN_RECHECK_JSON = path.join(ARTIFACTS_DIR, 'last-run-recheck.json');
export const REPORT_RECHECK_DIR = path.join(ARTIFACTS_DIR, 'report-recheck');

const nodeCollator = new Intl.Collator('en', { numeric: true });

/** Natural sort имён узлов: `srv2` раньше `srv10`. */
export function naturalSort(names) {
  return [...names].sort((a, b) => nodeCollator.compare(a, b));
}

/**
 * Строка `ИТОГ:` в консоли: НОРМА — зелёным, ПРОВАЛ — красным. Только в TTY и без
 * NO_COLOR; коды без bold, его conhost не рисует. `report.txt` — всегда без цвета.
 */
export function colorVerdict(text) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return text;
  }
  return text.replace(
    /^ИТОГ: (НОРМА|ПРОВАЛ)$/m,
    (line, v) => `\u001B[${v === 'НОРМА' ? 92 : 91}m${line}\u001B[0m`
  );
}

/** id последнего основного прогона из `last-run-id.txt`; нет, пуст или не читается — `''`. */
export function readLastRunId() {
  try {
    return fs.readFileSync(RUN_ID_PATH, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** Тот же класс символов, что в helpers/artifacts.ts: префикс отбора снимков совпадает с именем снимка. */
export function sanitize(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function splitCsv(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/** Непустые строки текста; общий разбор `readCsv` и `readCsvTail`. */
function splitLines(text) {
  return text.split(/\r?\n/).filter(Boolean);
}

/** Строка данных → объект по именам колонок шапки; общий разбор `readCsv` и `readCsvTail`. */
function rowFromLine(header, line) {
  const cells = splitCsv(line);
  return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
}

/**
 * Читает CSV → `{ header, rows }`; `rows` — объекты по именам колонок из
 * шапки. Пустой или отсутствующий файл — `null`.
 */
export function readCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const lines = splitLines(fs.readFileSync(filePath, 'utf-8'));
  if (lines.length === 0) {
    return null;
  }
  const header = splitCsv(lines[0]);
  const rows = lines.slice(1).map(line => rowFromLine(header, line));
  return { header, rows };
}

const NEWLINE = 0x0a;
const HEAD_BLOCK = 4096;
const BACK_BLOCK = 65536;
// Ключ-метка времени — 24 символа; длиннее 256 байт до разделителя это уже не метка.
const KEY_PROBE = 256;

/**
 * CSV с точки входа, найденной бинарным поиском по байтам, → `{ header, rows, startOffset }`;
 * нет файла или он пуст — `null`.
 *
 * Первая колонка (`keyColumn`) — ISO-8601 UTC, сравнивается с `since` строкой; начало
 * строки — байт `\n`. Точка входа — первая строка с ключом ≥ `since`, затем шаг назад на
 * `reserveLines` строк: запас на строки прохода, дописанные параллельными воркерами
 * вперемешку. Возвращаются все строки от этой позиции до конца файла; фильтр — у вызывающего.
 * Без `since`, при другой первой колонке или бесконечном `reserveLines` — чтение с начала
 * данных. `\n` внутри кавычек не поддерживается, как и в `readCsv`. Опирается на то, что файл
 * только дописывается, а беспорядок строк ограничен проходом.
 */
export function readCsvTail(filePath, { keyColumn, since = null, reserveLines = Infinity } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return null;
    }
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) {
      return null;
    }
    /** Байты `[pos, pos + len)` в пределах снимка размера. */
    const readRange = (pos, len) => {
      const n = Math.max(0, Math.min(len, size - pos));
      const buf = Buffer.alloc(n);
      let got = 0;
      while (got < n) {
        const r = fs.readSync(fd, buf, got, n - got, pos + got);
        if (r === 0) {
          break;
        }
        got += r;
      }
      return got === n ? buf : buf.subarray(0, got);
    };

    let headerEnd = size;
    for (let pos = 0; pos < size; pos += HEAD_BLOCK) {
      const i = readRange(pos, HEAD_BLOCK).indexOf(NEWLINE);
      if (i >= 0) {
        headerEnd = pos + i;
        break;
      }
    }
    const headerLine = readRange(0, headerEnd).toString('utf-8').replace(/\r$/, '');
    if (headerLine === '') {
      return null;
    }
    const header = splitCsv(headerLine);
    const dataStart = Math.min(headerEnd + 1, size);

    /** Начало ближайшей строки, не раньше `p`: позиция после `\n` с индексом ≥ `p − 1`. */
    const nextLineStart = p => {
      if (p <= dataStart) {
        return dataStart;
      }
      for (let pos = p - 1; pos < size; pos += HEAD_BLOCK) {
        const i = readRange(pos, HEAD_BLOCK).indexOf(NEWLINE);
        if (i >= 0) {
          return pos + i + 1;
        }
      }
      return size;
    };
    /** Верно, если ключ первой строки, начинающейся не раньше `p`, ≥ `since` (или строки нет / она оборвана). */
    const reached = p => {
      const s = nextLineStart(p);
      if (s >= size) {
        return true;
      }
      const probe = readRange(s, KEY_PROBE);
      let end = -1;
      for (let i = 0; i < probe.length; i += 1) {
        if (probe[i] === 0x2c || probe[i] === 0x0d || probe[i] === NEWLINE) {
          end = i;
          break;
        }
      }
      if (end < 0 && s + probe.length >= size) {
        // Незавершённая последняя строка: ключ мог оборваться на конце файла.
        return true;
      }
      const key = probe.subarray(0, end < 0 ? probe.length : end).toString('utf-8');
      return key >= since;
    };

    let start = dataStart;
    if (since != null && header[0] === keyColumn && Number.isFinite(reserveLines)) {
      let lo = dataStart;
      let hi = size;
      while (lo < hi) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (reached(mid)) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      const entry = nextLineStart(lo);
      if (reserveLines <= 0) {
        start = entry;
      } else {
        // Шаг назад: `\n` не бывает продолжающим байтом UTF-8, декодировать не нужно.
        let remaining = reserveLines;
        let end = entry - 1;
        scan: while (end > dataStart) {
          const from = Math.max(dataStart, end - BACK_BLOCK);
          const block = readRange(from, end - from);
          for (let i = block.length - 1; i >= 0; i -= 1) {
            remaining -= block[i] === NEWLINE ? 1 : 0;
            if (remaining === 0) {
              start = from + i + 1;
              break scan;
            }
          }
          end = from;
        }
      }
    }

    const rows = splitLines(readRange(start, size - start).toString('utf-8')).map(line =>
      rowFromLine(header, line)
    );
    return { header, rows, startOffset: start };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `readCsv`, который не бросает: при ошибке чтения печатает предупреждение с
 * префиксом вызывающего скрипта и возвращает `{ csv: null, error }`.
 */
export function readCsvOrWarn(filePath, prefix = 'webapp-monitor') {
  try {
    return { csv: readCsv(filePath), error: null };
  } catch (e) {
    console.warn(`[${prefix}] ${filePath} не прочитан: ${e.message}`);
    return { csv: null, error: e.message };
  }
}

/** `readCsvTail`, который не бросает: как `readCsvOrWarn`, `{ csv: null, error }` при ошибке чтения. */
export function readCsvTailOrWarn(filePath, opts, prefix = 'webapp-monitor') {
  try {
    return { csv: readCsvTail(filePath, opts), error: null };
  } catch (e) {
    console.warn(`[${prefix}] ${filePath} не прочитан: ${e.message}`);
    return { csv: null, error: e.message };
  }
}

// Как в helpers/config.ts.
export const CONFIG_PATH = path.resolve(BUNDLE_ROOT, process.env.MONITOR_CONFIG?.trim() || 'env.json');

/**
 * Число узлов (`targets`) в конфиге или `null`. Ошибки глотаются молча: в конфиге пароль, а
 * текст ошибки `JSON.parse` несёт фрагмент исходника.
 */
export function readConfigTargetCount(configPath = CONFIG_PATH) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const targets = cfg?.targets;
    if (targets === null || typeof targets !== 'object' || Array.isArray(targets)) {
      return null;
    }
    return Object.keys(targets).length;
  } catch {
    return null;
  }
}

/** Колонки runs.csv, которые читаются для запаса точки входа; `repeat_each` необязателен. */
export const ENTRY_RESERVE_RUNS_COLUMNS = ['targets', 'repeat_each'];

/**
 * Запас точки входа в строках metrics.csv — двойной размер прохода: узлы × шаги × repeat_each × 2.
 * Узлы — максимум по конфигу и runs.csv (metrics.csv общий для контуров); repeat_each — максимум
 * по runs.csv, иначе 1. Узлов нет — `Infinity`: читать с начала данных.
 */
export function entryReserveLines(runsRows, configTargetCount) {
  let nodes = configTargetCount ?? 0;
  let repeat = 1;
  for (const r of runsRows) {
    const n = String(r.targets || '')
      .split(';')
      .filter(s => s.trim() !== '').length;
    nodes = Math.max(nodes, n);
    const rep = Number(r.repeat_each);
    if (Number.isInteger(rep) && rep >= 1) {
      repeat = Math.max(repeat, rep);
    }
  }
  // Шагов на узел: в поставляемом сценарии 3, у своего — сколько объявлено. Запас эвристический
  // (страховка от строк прохода, дописанных вперемешку), точность не нужна.
  return nodes === 0 ? Infinity : nodes * 3 * repeat * 2;
}

/** Обычный файл по пути; нет пути, это каталог или чтение упало — `false`. */
export function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
