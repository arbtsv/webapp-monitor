/**
 * Отчёт последнего прогона: `report.txt` и архив `report_<run_id>.zip` (HTML-отчёт
 * Playwright, `report.txt`, `run.json`, каталог `screenshots/` целиком, при перепроверке —
 * `report-recheck/`). `report.zip` — копия архива последнего прогона под постоянным именем.
 * Снимки удаляются только после успешной упаковки; готовый архив повторно не собирается.
 *
 * В консоль печатается полный отчёт, как в report.txt; `ИТОГ` в цвете — только в TTY и
 * без NO_COLOR. Оркестратор импортирует `buildReport()` и вызывает её после прогона в любом
 * исходе; CLI-обёртка сохранена для ручного запуска.
 *
 * Запуск: node scripts/report.mjs
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import {
  ARTIFACTS_DIR,
  CSV_PATH,
  RUN_ID_PATH,
  readLastRunId,
  LAST_RUN_JSON,
  LAST_RUN_RECHECK_JSON,
  REPORT_DIR,
  REPORT_RECHECK_DIR,
  SCREENSHOT_DIR,
  REPORT_TXT,
  REPORT_ZIP,
  RECHECK_SUFFIX,
  RUNS_CSV_PATH,
  RUN_JSON,
  colorVerdict,
  naturalSort,
  sanitize,
  readCsvOrWarn,
  readCsvTailOrWarn,
  readConfigTargetCount,
  entryReserveLines,
  runReportZipPath,
  isRegularFile,
} from './common.mjs';

/**
 * Очистка ANSI, как `stripAnsiEscapes` Playwright. Константы — до первого использования:
 * модуль исполняется сверху вниз, иначе TDZ.
 */
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex -- ESC и есть искомый символ
  /([\u001B\u009B][[\]()#?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{0,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])))/g;

function stripAnsi(text) {
  return text.replace(ANSI_REGEX, '');
}

// Заглушка блока «Упавшие проверки»: renderReport раскрывает её полным текстом ошибок.
const FAILURES_BLOCK = Symbol('failures');

/**
 * Человеческий текст отчёта из вложений `timings` сценария: подписи метрик (`labels`,
 * имя → подпись), заголовок (`title`) и легенда (`legend`, список строк). Текст принадлежит
 * сценарию — ядро предметно-нейтрально; fallback у ядра: сырое имя метрики, нейтральный
 * заголовок, без легенды.
 */
function collectScenarioText(json) {
  const text = { labels: {}, title: '', legend: [] };
  if (!json) {
    return text;
  }
  const walkSuite = suite => {
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        for (const result of t.results || []) {
          const attachment = (result.attachments || []).find(a => a.name === 'timings' && a.body);
          if (!attachment) {
            continue;
          }
          try {
            const timings = JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf-8'));
            Object.assign(text.labels, timings.labels || {});
            if (!text.title && typeof timings.title === 'string') {
              text.title = timings.title;
            }
            if (Array.isArray(timings.legend) && timings.legend.length > 0) {
              text.legend = timings.legend.map(String);
            }
          } catch {
            // Вложение не читается — текста нет, отчёт уйдёт на fallback.
          }
        }
      }
    }
    for (const child of suite.suites || []) {
      walkSuite(child);
    }
  };
  for (const suite of json.suites || []) {
    walkSuite(suite);
  }
  return text;
}

/**
 * Колонка `timeouts` из runs.csv (`<режим>:<stepMs>/<testMs>/<actionMs>/<navigationMs>`)
 * → «шаг 30 с, тест 180 с, …»; режим, отличный от `default`, дописывается `(режим <mode>)`.
 * Нераспознанное значение возвращается как есть.
 */
const TIMEOUTS_RE = /^([^:]+):(\d+)\/(\d+)\/(\d+)\/(\d+)$/;

function formatTimeoutSeconds(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) {
    return String(ms);
  }
  const sec = n / 1000;
  if (Number.isInteger(sec)) {
    return String(sec);
  }
  return String(Math.round(sec * 100) / 100);
}

function formatTimeouts(raw) {
  const m = TIMEOUTS_RE.exec(String(raw == null ? '' : raw));
  if (!m) {
    return String(raw);
  }
  const [, mode, stepMs, testMs, actionMs, navigationMs] = m;
  let text =
    `шаг ${formatTimeoutSeconds(stepMs)} с, тест ${formatTimeoutSeconds(testMs)} с, ` +
    `действие ${formatTimeoutSeconds(actionMs)} с, навигация ${formatTimeoutSeconds(navigationMs)} с`;
  if (mode !== 'default') {
    text += ` (режим ${mode})`;
  }
  return text;
}

/**
 * Сборка отчёта последнего прогона. Код возврата: 0 — отчёт построен; 1 — фатально (нет
 * файла id прогона) или часть операций не удалась (архив, копия report.zip) — текст причин
 * напечатан с префиксом `[report]`.
 */
export function buildReport() {
  const runId = readLastRunId();
  if (!runId) {
    console.error(`[report] ${RUN_ID_PATH} не найден, пуст или не читается — сначала выполните прогон`);
    return 1;
  }

  // --- замеры этого прогона -------------------------------------------------
  //
  // Замеров может не быть (цель недоступна) — отчёт и архив строятся и тогда.

  // runs.csv — первым: начало прогона из него — точка входа в metrics.csv. Нечитаемый runs.csv
  // убирает только блок «Параметры прогона».
  const runsRead = readCsvOrWarn(RUNS_CSV_PATH, 'report');
  const runsCsv = runsRead.csv;
  const recheckRunId = `${runId}${RECHECK_SUFFIX}`;
  const mainRunRow = runsCsv ? [...runsCsv.rows].reverse().find(r => r.run_id === runId) : null;
  const recheckRunRow = runsCsv ? [...runsCsv.rows].reverse().find(r => r.run_id === recheckRunId) : null;

  // Метки времени metrics.csv — `toISOString()`, сравниваются строкой: граница нужна в том же виде.
  // Нет строки прогона или started_at не в этом виде — файл читается целиком.
  const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const metricsSince = ISO_UTC_RE.test(String(mainRunRow?.started_at)) ? mainRunRow.started_at : null;
  const metricsRead = readCsvTailOrWarn(
    CSV_PATH,
    {
      keyColumn: 'timestamp',
      since: metricsSince,
      reserveLines: entryReserveLines(runsCsv?.rows ?? [], readConfigTargetCount()),
    },
    'report'
  );
  const allRows = metricsRead.csv?.rows ?? [];
  const rows = allRows.filter(r => r.run_id === runId);

  // Строки перепроверки этого прогона — свой run_id с суффиксом.
  const recheckRows = allRows.filter(r => r.run_id === recheckRunId);

  // --- исход и порядок узлов --------------------------------------------------
  //
  // Испорченный, отсутствующий или чужой JSON не роняет отчёт: исход тестов неизвестен
  // (ИТОГ: ПРОВАЛ), HTML-отчёт не пакуется.

  // JSON принимается, только если его config.metadata.run_id совпадает с этим прогоном.
  let rawJson = null;
  let outcome = { total: 0, passed: 0, failed: 0, failures: [] };
  if (fs.existsSync(LAST_RUN_JSON)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(LAST_RUN_JSON, 'utf-8'));
      if ((parsed.config?.metadata || {}).run_id === runId) {
        rawJson = parsed;
        outcome = summarize(rawJson);
      }
    } catch {
      rawJson = null;
    }
  }

  // JSON перепроверки — только если описывает перепроверку этого прогона.
  let recheckJson = null;
  if (fs.existsSync(LAST_RUN_RECHECK_JSON)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(LAST_RUN_RECHECK_JSON, 'utf-8'));
      if ((parsed.config?.metadata || {}).recheck_of === runId) {
        recheckJson = parsed;
      }
    } catch {
      recheckJson = null;
    }
  }

  // Человеческий текст отчёта — из вложений `timings` сценария (основной прогон и
  // перепроверка); fallback'и у ядра нейтральны.
  const mainText = collectScenarioText(rawJson);
  const recheckText = collectScenarioText(recheckJson);
  const metricLabels = { ...mainText.labels, ...recheckText.labels };
  const metricLongLabel = id => metricLabels[id] || id;
  const reportTitle = mainText.title || 'Мониторинг веб-кабинета';
  const legend = mainText.legend.length > 0 ? mainText.legend : recheckText.legend;

  // Вердикт — только по основному проходу. НОРМА требует известного исхода
  // тестов (JSON этого прогона), ни одного упавшего теста, ни одной строки
  // slow и хотя бы одного замера.
  const slow = rows.filter(r => r.verdict === 'slow');
  const outcomeKnown = rawJson !== null;
  const verdict = !outcomeKnown || outcome.failed > 0 || slow.length > 0 || rows.length === 0 ? 'ПРОВАЛ' : 'НОРМА';

  // Порядок узлов — как в проектах JSON, если там есть все узлы из CSV; иначе natural sort.
  const csvNodes = [...new Set(rows.map(r => r.target))];
  const jsonNodeOrder =
    rawJson && Array.isArray(rawJson.config?.projects) ? rawJson.config.projects.map(p => p.name) : null;
  const nodeOrder = orderNodes(csvNodes, jsonNodeOrder);
  const nodeIndexOf = name => {
    const idx = nodeOrder.indexOf(name);
    return idx === -1 ? nodeOrder.length : idx;
  };

  // Тем же ключом упорядочены «Превышение порога» и «Упавшие проверки».
  const orderedSlow = nodeOrder.flatMap(node => slow.filter(r => r.target === node));
  const orderedFailures = outcome.failures
    .map((f, i) => ({ f, i }))
    .sort((a, b) => nodeIndexOf(a.f.project) - nodeIndexOf(b.f.project) || a.i - b.i)
    .map(x => x.f);

  // --- plain-text отчёт -----------------------------------------------------

  const environment = rows[0]?.environment ?? mainRunRow?.environment ?? 'неизвестен';
  const lines = [];
  lines.push(`${reportTitle} — ${verdict}`);
  lines.push('');
  lines.push(`Контур:  ${environment}`);
  lines.push(`Прогон:  ${runId}`);
  const runStart = parseRunStart(runId);
  if (runStart) {
    // id не распознан (например, ручной MONITOR_RUN_ID) — строки нет: id уже показан в «Прогон».
    lines.push(`Старт:   ${runStart.toLocaleString('ru-RU')}`);
  }
  lines.push(`Снят:    ${new Date().toLocaleString('ru-RU')}`);
  lines.push(
    outcomeKnown
      ? `Тесты:   ${outcome.passed} из ${outcome.total} пройдено`
      : 'Тесты:   исход неизвестен — нет JSON-отчёта этого прогона (прогон оборван?)'
  );
  if (rows.length === 0) {
    lines.push(
      metricsRead.error
        ? `Замеры: ${path.basename(CSV_PATH)} не прочитан (${metricsRead.error}).`
        : 'Замеры: нет ни одного — ни один узел не дошёл до первого замера.'
    );
  }
  lines.push('');

  // --- «Параметры прогона» -----------------------------------------

  let runJsonWritten = false;
  if (mainRunRow) {
    lines.push('Параметры прогона:');
    lines.push(`  конфиг: ${mainRunRow.config_file} (${mainRunRow.environment})`);
    lines.push(`  сценарий: ${mainRunRow.scenario || 'не записан'}`);
    lines.push(`  узлы: ${mainRunRow.targets}`);
    lines.push(`  фильтр узлов: ${process.env.MONITOR_TARGET?.trim() || 'не задан'}`);
    lines.push(`  машина: ${mainRunRow.host}; ядер: ${mainRunRow.cpu_count}; воркеров: ${mainRunRow.workers}`);
    lines.push(`  таймауты: ${formatTimeouts(mainRunRow.timeouts)}`);
    lines.push(
      `  версии: node ${mainRunRow.node_version}, playwright ${mainRunRow.playwright_version}, ` +
        `бандл ${mainRunRow.bundle_version}`
    );
    lines.push('');

    const runJson = { ...mainRunRow, recheck: recheckRunRow ? { ...recheckRunRow } : null };
    fs.writeFileSync(RUN_JSON, JSON.stringify(runJson, null, 2), 'utf-8');
    runJsonWritten = true;
  } else {
    lines.push(
      runsRead.error
        ? `Параметры прогона: ${path.basename(RUNS_CSV_PATH)} не прочитан (${runsRead.error}).`
        : `Параметры прогона: в ${path.basename(RUNS_CSV_PATH)} нет строки этого прогона`
    );
    lines.push('');
  }

  // --- выравнивание строк замеров -----------------------------
  //
  // Ширины подписи и порога — по всем строкам отчёта, включая перепроверку, чтобы
  // колонки совпадали между разделами.

  const allShownRows = [...rows, ...recheckRows];
  const metricLabelWidth = Math.max(0, ...allShownRows.map(r => metricLongLabel(r.metric).length));
  const thresholdWidth = Math.max(0, ...allShownRows.map(r => `x${r.max_ratio}`.length));

  for (const target of nodeOrder) {
    const targetRows = rows.filter(r => r.target === target);
    lines.push(`Узел ${target}  (${targetRows[0].url})`);
    for (const r of targetRows) {
      lines.push(metricRow(r, 2, metricLabelWidth, thresholdWidth, metricLongLabel));
    }
    lines.push('');
  }

  if (orderedSlow.length > 0) {
    lines.push('Превышение порога:');
    for (const r of orderedSlow) {
      lines.push(
        `  ${r.target} / ${metricLongLabel(r.metric)}: ${seconds(r.duration_ms)} с при эталоне ` +
          `${seconds(r.reference_ms)} с (x${Number(r.ratio).toFixed(2)})`
      );
    }
    lines.push('');
  }

  // На месте блока — заглушка: report.txt раскрывает её ниже.
  lines.push(FAILURES_BLOCK);

  // --- «Перепроверка» ---------------------------------------------
  //
  // Справочный раздел: вердикт и код возврата построены выше и от него не зависят.

  const recheckOutcomes = recheckJson ? outcomesByProject(recheckJson) : new Map();
  const recheckHappened = recheckRows.length > 0 || recheckOutcomes.size > 0;
  const slowNodeNames = [...new Set(orderedSlow.map(r => r.target))];

  if (!recheckHappened) {
    if (slowNodeNames.length > 0) {
      lines.push(`Перепроверка: не проводилась (узлы с превышением порога: ${slowNodeNames.join(', ')})`);
      lines.push('');
    }
  } else {
    const recheckNodesSet = new Set([...recheckOutcomes.keys(), ...recheckRows.map(r => r.target)]);
    const recheckNodes = orderWithFallback([...recheckNodesSet], nodeOrder);
    const nodeLabelWidth = Math.max(0, ...recheckNodes.map(n => n.length));

    lines.push(`Перепроверка (прогон ${recheckRunId}; на вердикт и код возврата не влияет):`);
    for (const node of recheckNodes) {
      const nodeRecheckRows = recheckRows.filter(r => r.target === node);
      const stillSlow = nodeRecheckRows.some(r => r.verdict === 'slow');
      const outcomeEntry = recheckOutcomes.get(node);

      let status;
      if (stillSlow) {
        status = 'всё ещё медленно';
      } else if (outcomeEntry && !outcomeEntry.allPassed) {
        status = 'сбой';
      } else if (outcomeEntry && outcomeEntry.allPassed) {
        status = 'норма';
      } else {
        status = 'исход неизвестен (нет JSON-отчёта перепроверки)';
      }

      lines.push(`  ${node.padEnd(nodeLabelWidth)} ${status}`);
      if (status === 'сбой' && outcomeEntry?.firstError) {
        lines.push(`      ${outcomeEntry.firstError}`);
      }
      for (const r of nodeRecheckRows) {
        lines.push(metricRow(r, 4, metricLabelWidth, thresholdWidth, metricLongLabel));
      }
    }
    lines.push('');
  }

  // Легенда метрик — от сценария; без неё блока нет (ядро предметно-нейтрально).
  if (legend.length > 0) {
    for (const line of legend) {
      lines.push(line);
    }
    lines.push('');
  }

  lines.push('HTML-отчёт Playwright и снимки экрана — в архиве прогона.');
  lines.push('Снимок делается всегда: при успехе — с содержимым раздела в кадре,');
  lines.push('при падении — место падения.');
  lines.push('');
  lines.push(`ИТОГ: ${verdict}`);

  const reportText = renderReport(lines, failureLines(orderedFailures));
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(REPORT_TXT, reportText, 'utf-8');

  // --- архив прогона и копия report.zip --------------------------------------
  //
  // Служебные строки — перед отчётом, чтобы «ИТОГ» остался последней строкой, и только в
  // stdout: на Windows запись в TTY асинхронна, порядок двух потоков не гарантирован.
  const messages = [];
  let hadProblems = false;

  const shots = fs.existsSync(SCREENSHOT_DIR)
    ? fs.readdirSync(SCREENSHOT_DIR).filter(n => n.startsWith(`${sanitize(runId)}-`) && n.endsWith('.png'))
    : [];

  const toPack = [];
  if (rawJson && fs.existsSync(REPORT_DIR)) {
    toPack.push(REPORT_DIR);
  }
  // Каталог перепроверки пакуется, только если её JSON принят, — иначе в архив мог бы
  // попасть чужой HTML-отчёт. В нём же лежат снимки перепроверки.
  if (recheckJson && fs.existsSync(REPORT_RECHECK_DIR)) {
    toPack.push(REPORT_RECHECK_DIR);
  }
  toPack.push(REPORT_TXT);
  if (runJsonWritten) {
    toPack.push(RUN_JSON);
  }
  // Снимки этого прогона — списком с именами записей screenshots/<имя>: каталог на диске
  // общий, и целиком он утянул бы остатки чужих прогонов (если их архив не пересобирался
  // и снимки не были удалены). Экономия sha1-дедупа (~1-2 МБ) несущественна против простоты.
  for (const s of shots) {
    toPack.push({ src: path.join(SCREENSHOT_DIR, s), rel: `screenshots/${s}` });
  }

  const runZipPath = runReportZipPath(runId);
  const ZIP_LIST = path.join(ARTIFACTS_DIR, `.zip-list.${process.pid}.txt`);
  let archiveReady = false;
  let builtNow = false;

  if (isRegularFile(runZipPath)) {
    // Снимки прогона могли быть удалены прошлой упаковкой — пересборка потеряла бы их.
    messages.push(`[report] ${runZipPath} уже собран — не пересобираю`);
    archiveReady = true;
  } else {
    try {
      // Удаление — в том же try: непустой посторонний каталог на этом месте провалит и
      // удаление, и сборку, без рекурсивного сноса.
      fs.rmSync(runZipPath, { force: true });
      // $ErrorActionPreference = 'Stop': иначе ошибка CreateEntryFromFile внутри ForEach-Object
      // не завершающая, и неполный архив дал бы код 0, а за ним — удаление снимков.
      try {
        // Список — промежуточный файл, убирается в finally при любом сбое.
        fs.writeFileSync(ZIP_LIST, zipListText(toPack), 'utf-8');
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', buildZipScript(ZIP_LIST, runZipPath)], {
          stdio: 'pipe',
        });
      } finally {
        fs.rmSync(ZIP_LIST, { force: true });
      }
      if (isRegularFile(runZipPath) && fs.statSync(runZipPath).size > 0) {
        builtNow = true;
        archiveReady = true;
        messages.push(`[report] ${runZipPath} (снимков: ${shots.length})`);
      } else {
        hadProblems = true;
        messages.push(`[report] сборка ${runZipPath} не дала обычного файла ненулевого размера`);
        if (isRegularFile(runZipPath)) {
          fs.rmSync(runZipPath, { force: true });
        }
      }
    } catch (e) {
      hadProblems = true;
      messages.push(`[report] не удалось собрать ${runZipPath}: ${e.message}`);
      // Остаток архива удаляется, только если это обычный файл; каталог не трогается.
      if (isRegularFile(runZipPath)) {
        fs.rmSync(runZipPath, { force: true });
      }
    }
  }

  if (archiveReady) {
    try {
      fs.copyFileSync(runZipPath, REPORT_ZIP);
    } catch (e) {
      hadProblems = true;
      messages.push(`[report] не удалось скопировать ${runZipPath} в ${REPORT_ZIP}: ${e.message}`);
    }
  }

  if (builtNow) {
    // Только снимки, упакованные в этот архив, и только после успешной упаковки.
    const notRemoved = [];
    for (const s of shots) {
      try {
        fs.rmSync(path.join(SCREENSHOT_DIR, s), { force: true });
      } catch {
        notRemoved.push(s);
      }
    }
    if (notRemoved.length > 0) {
      hadProblems = true;
      messages.push(`[report] не удалось удалить: ${notRemoved.join(', ')}`);
    }
  } else if (shots.length > 0) {
    messages.push(`[report] архив не пересобирался — снимков на диске оставлено: ${shots.length}`);
  }

  for (const m of messages) {
    console.log(m);
  }
  console.log(colorVerdict(reportText));

  return hadProblems ? 1 : 0;
}

/** CLI-обёртка: ручной запуск `node scripts/report.mjs`. Оркестратор импортирует buildReport. */
function main() {
  process.exitCode = buildReport();
}

// Импорт из оркестратора не должен печатать: обёртка работает только при прямом запуске.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

// --- вспомогательное ------------------------------------------------------

/**
 * Строка одного замера. `indent` — 2 у узлов основного прохода, 4 у перепроверки;
 * `labelWidth`/`thresholdWidth` — общие для всех разделов.
 */
function metricRow(r, indent, labelWidth, thresholdWidth, labelOf) {
  const pad = ' '.repeat(indent);
  const label = labelOf(r.metric).padEnd(labelWidth);
  const flag = r.verdict === 'slow' ? '  << МЕДЛЕННО' : '';
  const ratio = `x${Number(r.ratio).toFixed(2)}`.padStart(6);
  const threshold = `x${r.max_ratio}`.padStart(thresholdWidth);
  return (
    `${pad}${label} ${seconds(r.duration_ms).padStart(6)} с   ` +
    `эталон ${seconds(r.reference_ms).padStart(6)} с   ` +
    `${ratio} (порог ${threshold})${flag}`
  );
}

/** Мс → секунды, только для показа: CSV, `thresholds` и `*_ms` остаются в миллисекундах. */
function seconds(ms) {
  return (Number(ms) / 1000).toFixed(2);
}

/** Текст отчёта: строки через CRLF, заглушка блока падений заменена `failures`. */
function renderReport(reportLines, failures) {
  return reportLines.flatMap(l => (l === FAILURES_BLOCK ? failures : [l])).join('\r\n') + '\r\n';
}

/** Блок «Упавшие проверки» — полный текст ошибок, как в report.txt. */
function failureLines(failures) {
  if (failures.length === 0) {
    return [];
  }
  const out = ['Упавшие проверки:'];
  for (const f of failures) {
    out.push(`  [${f.project}] ${f.title}`);
    for (const l of stripAnsi(String(f.error || '')).split(/\r?\n/).slice(0, 6)) {
      out.push(`      ${l}`);
    }
  }
  out.push('');
  return out;
}

/**
 * Порядок узлов: индекс в проектах JSON, если там есть все узлы из CSV; иначе natural
 * sort (`srv2` раньше `srv10`).
 */
function orderNodes(nodes, jsonOrder) {
  if (jsonOrder && nodes.every(n => jsonOrder.includes(n))) {
    return [...nodes].sort((a, b) => jsonOrder.indexOf(a) - jsonOrder.indexOf(b));
  }
  return naturalSort(nodes);
}

/**
 * Порядок для раздела «Перепроверка»: узлы, присутствующие в `primaryOrder`
 * (порядок основного прохода), идут в его порядке; остальные — в конец,
 * natural sort по имени.
 */
function orderWithFallback(names, primaryOrder) {
  const known = names
    .filter(n => primaryOrder.includes(n))
    .sort((a, b) => primaryOrder.indexOf(a) - primaryOrder.indexOf(b));
  const rest = naturalSort(names.filter(n => !primaryOrder.includes(n)));
  return [...known, ...rest];
}

/**
 * Дата старта из начала run_id (`YYYYMMDD-HHMMSS`, дальше конец строки или дефис);
 * `null`, если id не в этом формате, — тогда строки «Старт» нет.
 */
function parseRunStart(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?=-|$)/.exec(id);
  if (!m) {
    return null;
  }
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  // Date переносит «перелив» (13-й месяц) на следующий — компоненты сверяются буквально.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }
  return date;
}

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * PowerShell-скрипт сборки zip через .NET ZipFile. Не Compress-Archive: это модуль .psm1, его
 * блокирует ограничительный ExecutionPolicy, в том числе групповой политикой, которую
 * `-ExecutionPolicy Bypass` не перекрывает; .NET-сборку политика не касается. Пути — из
 * `listFile`: командная строка Windows ограничена 32767 символами. Каталог ложится в архив
 * под своим именем, файл — в корень.
 */
function buildZipScript(listFile, destZip) {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    'Add-Type -AssemblyName System.IO.Compression',
    `$dest = ${psQuote(destZip)}`,
    `$items = [System.IO.File]::ReadAllLines(${psQuote(listFile)}, [System.Text.Encoding]::UTF8)`,
    '$level = [System.IO.Compression.CompressionLevel]::Optimal',
    'if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }',
    '$zip = [System.IO.Compression.ZipFile]::Open($dest, [System.IO.Compression.ZipArchiveMode]::Create)',
    'try {',
    '  foreach ($item in $items) {',
    '    if (-not $item) { continue }',
    '    $kind = $item.Substring(0, 1); $p = $item.Substring(2)',
    '    if ($kind -eq "D") {',
    '      $baseName = Split-Path -Leaf $p',
    '      Get-ChildItem -LiteralPath $p -Recurse -File | ForEach-Object {',
    '        $rel = $baseName + "/" + $_.FullName.Substring($p.Length + 1).Replace("\\", "/")',
    '        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, $level) | Out-Null',
    '      }',
    '    } elseif ($kind -eq "R") {',
    '      $tab = $p.IndexOf("`t")',
    '      $src = $p.Substring(0, $tab)',
    '      $relName = $p.Substring($tab + 1).Replace("\\", "/")',
    '      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $src, $relName, $level) | Out-Null',
    '    } else {',
    '      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $p, (Split-Path -Leaf $p), $level) | Out-Null',
    '    }',
    '  }',
    '} finally {',
    '  $zip.Dispose()',
    '}',
  ].join('\n');
}

/**
 * Список для buildZipScript: `D<TAB>путь` для каталога, `F<TAB>путь` для файла в корень
 * архива, `R<TAB>src<TAB>relName` для файла под явным именем записи (снимки — под
 * screenshots/<имя>). Элемент строки — путь либо `{ src, rel }`.
 */
function zipListText(items) {
  return (
    items
      .map(item => {
        if (typeof item === 'string') {
          return `${fs.statSync(item).isDirectory() ? 'D' : 'F'}\t${item}`;
        }
        return `R\t${item.src}\t${item.rel}`;
      })
      .join('\n') + '\n'
  );
}

function summarize(json) {
  const result = { total: 0, passed: 0, failed: 0, failures: [] };
  const walk = suite => {
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        result.total += 1;
        const last = (t.results || [])[t.results.length - 1];
        if (last && last.status === 'passed') {
          result.passed += 1;
        } else {
          result.failed += 1;
          result.failures.push({
            project: t.projectName || '',
            title: spec.title,
            error: last && last.error ? last.error.message : '',
            thresholdFailures: [],
          });
        }
      }
    }
    for (const child of suite.suites || []) {
      walk(child);
    }
  };
  for (const suite of json.suites || []) {
    walk(suite);
  }
  return result;
}

/**
 * Исход по узлам JSON-отчёта для «Перепроверки»: прошли ли все тесты узла (по последней
 * попытке) и первая строка ошибки первого упавшего.
 */
function outcomesByProject(json) {
  const map = new Map();
  const walk = suite => {
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const project = t.projectName || '';
        const last = (t.results || [])[t.results.length - 1];
        const passed = Boolean(last && last.status === 'passed');
        const entry = map.get(project) || { allPassed: true, firstError: null };
        entry.allPassed = entry.allPassed && passed;
        if (!passed && !entry.firstError) {
          const raw = last && last.error ? last.error.message : '';
          const cleaned = stripAnsi(String(raw || ''));
          const line = cleaned.split(/\r?\n/).find(l => l.trim().length > 0);
          entry.firstError = line || null;
        }
        map.set(project, entry);
      }
    }
    for (const child of suite.suites || []) {
      walk(child);
    }
  };
  for (const suite of json.suites || []) {
    walk(suite);
  }
  return map;
}
