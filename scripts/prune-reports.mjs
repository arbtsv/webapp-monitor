/**
 * Чистка архивов `report_<run_id>.zip` в `artifacts/`: спрашивает срок в днях, показывает,
 * что будет удалено, и после подтверждения удаляет более старые. Возраст — по времени
 * изменения файла. Архив последнего прогона, `report.zip`, CSV и график не трогаются.
 *
 * Запуск: node scripts/prune-reports.mjs [--days N] [--yes]
 * `--days N` — не спрашивать срок; `--yes` — и подтверждение, только вместе с `--days`.
 * Коды: 0 — готово, удалять нечего или отказ; 1 — часть файлов не удалена; 2 — неверный ввод.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ARTIFACTS_DIR, readLastRunId, sanitize } from './common.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
// Только `report_<...>.zip`: постоянное имя `report.zip` под шаблон не попадает.
const RUN_ZIP_RE = /^report_.+\.zip$/;

const args = process.argv.slice(2);
const ASSUME_YES = args.includes('--yes');

/** Значение `--days N` или `--days=N`; `undefined`, если флага нет. */
function daysArg() {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') {
      return args[i + 1] ?? '';
    }
    if (args[i].startsWith('--days=')) {
      return args[i].slice('--days='.length);
    }
  }
  return undefined;
}

/** Целое число дней ≥ 0 или `null`. */
function parseDays(text) {
  const t = String(text).trim();
  return /^\d{1,5}$/.test(t) ? Number(t) : null;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** `{ p, st }` для обычного файла; каталог, исчезнувший или недоступный файл — `null`. */
function statRegularFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? { p, st } : null;
  } catch {
    return null;
  }
}

// Итератор строк, а не rl.question: из конвейера обе строки приходят одним куском, и второй
// question остался бы без ответа.
const rl = readline.createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const ask = async question => {
  process.stdout.write(question);
  const { value, done } = await lines.next();
  if (done) {
    console.log(''); // stdin закрыт — то же, что пустой ответ.
    return '';
  }
  return value;
};

async function main() {
  // Аргументы проверяются до обращения к диску: код возврата не зависит от наличия каталога.
  const given = daysArg();
  if (ASSUME_YES && given === undefined) {
    console.error('[prune] --yes требует --days N: без срока подтверждение пропускать нельзя');
    return 2;
  }
  let days = given === undefined ? null : parseDays(given);
  if (given !== undefined && days === null) {
    console.error(`[prune] --days: нужно целое число дней, получено "${given}"`);
    return 2;
  }
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    console.log(`[prune] каталога ${ARTIFACTS_DIR} нет — удалять нечего`);
    return 0;
  }
  if (days === null) {
    const answer = await ask('За сколько последних дней оставить архивы отчётов? (число дней, пусто — отмена): ');
    if (answer.trim() === '') {
      console.log('[prune] отмена — ничего не удалено');
      return 0;
    }
    days = parseDays(answer);
    if (days === null) {
      console.error(`[prune] нужно целое число дней, получено "${answer.trim()}"`);
      return 2;
    }
  }

  const border = Date.now() - days * DAY_MS;
  // Архив последнего прогона не удаляется и при `--days 0`: повторный report.mjs пересобрал
  // бы его уже без снимков экрана.
  const lastRunId = readLastRunId();
  const protectedName = lastRunId === '' ? '' : `report_${sanitize(lastRunId)}.zip`;
  if (protectedName === '') {
    console.warn('[prune] last-run-id.txt не найден или пуст — архив последнего прогона не защищён');
  }
  const all = fs
    .readdirSync(ARTIFACTS_DIR)
    .filter(n => RUN_ZIP_RE.test(n))
    .map(n => statRegularFile(path.join(ARTIFACTS_DIR, n)))
    .filter(f => f !== null);
  const isProtected = f => path.basename(f.p) === protectedName;
  const old = all.filter(f => f.st.mtimeMs < border && !isProtected(f)).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  if (all.some(isProtected)) {
    console.log(`[prune] защищён архив последнего прогона: ${protectedName}`);
  }
  const keepCount = all.length - old.length;

  if (old.length === 0) {
    console.log(`[prune] архивов старше ${days} дн. нет (всего архивов: ${all.length}) — удалять нечего`);
    return 0;
  }

  const total = old.reduce((sum, f) => sum + f.st.size, 0);
  console.log(`[prune] будет удалено архивов старше ${days} дн.: ${old.length} из ${all.length}, ${mb(total)} МБ; останется: ${keepCount}`);
  for (const f of old) {
    console.log(`  ${path.basename(f.p)}  ${f.st.mtime.toLocaleString('ru-RU')}  ${mb(f.st.size)} МБ`);
  }

  if (!ASSUME_YES) {
    const ok = (await ask('Удалить? [y/д/N] ')).trim().toLowerCase();
    if (ok !== 'y' && ok !== 'д') {
      console.log('[prune] отмена — ничего не удалено');
      return 0;
    }
  }

  let removed = 0;
  let freed = 0;
  const failed = [];
  for (const f of old) {
    try {
      fs.rmSync(f.p);
      removed++;
      freed += f.st.size;
    } catch (e) {
      failed.push(`${path.basename(f.p)}: ${e.message}`);
    }
  }
  console.log(`[prune] удалено: ${removed}, освобождено ${mb(freed)} МБ`);
  for (const m of failed) {
    console.error(`[prune] не удалось удалить ${m}`);
  }
  return failed.length > 0 ? 1 : 0;
}

main().then(
  code => {
    rl.close();
    process.exitCode = code;
  },
  e => {
    rl.close();
    console.error(`[prune] ${e.message}`);
    process.exitCode = 2;
  }
);
