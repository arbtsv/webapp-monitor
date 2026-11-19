/**
 * Узлы со строками `verdict=slow` прогона — для перепроверки в оркестраторе. Таймаут
 * или исключение строки не оставляют, такой узел не перепроверяется.
 *
 * Потребители двое: оркестратор импортирует `slowTargets`, чейн можно гонять и по
 * частям вручную — CLI-обёртка печатает имена узлов по одному на строку, без повторов,
 * в порядке CSV. Нет данных — пустой вывод, код 0. Имя вне `^[A-Za-z0-9._-]+$` не
 * печатается (уходило бы в командную строку) — вместо него предупреждение в stderr.
 *
 * CLI: node scripts/slow-targets.mjs [run_id] (по умолчанию — из `last-run-id.txt`).
 */
import { pathToFileURL } from 'url';
import { CSV_PATH, readCsvOrWarn, readLastRunId } from './common.mjs';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Имена узлов прогона `runIdValue` с вердиктом `slow` — уникальные, в порядке CSV,
 * только из безопасного для командной строки набора символов.
 */
export function slowTargets(runIdValue, { csvPath = CSV_PATH } = {}) {
  if (!runIdValue) {
    return [];
  }
  const csv = readCsvOrWarn(csvPath, 'slow-targets').csv;
  if (!csv) {
    return [];
  }

  const seen = new Set();
  const names = [];
  for (const row of csv.rows) {
    if (row.run_id !== runIdValue || row.verdict !== 'slow') {
      continue;
    }
    const name = row.target;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    if (!NAME_RE.test(name)) {
      console.error(`[slow-targets] узел "${name}" не перепроверяется — недопустимые символы в имени`);
      continue;
    }
    names.push(name);
  }
  return names;
}

/** CLI-обёртка: имена узлов в stdout по одному на строку. */
function main() {
  const runId = (process.argv[2] || '').trim() || readLastRunId();
  for (const name of slowTargets(runId)) {
    console.log(name);
  }
}

// Импорт из оркестратора не должен печатать: обёртка работает только при прямом запуске.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
