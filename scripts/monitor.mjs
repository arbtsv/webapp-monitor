#!/usr/bin/env node
/**
 * Node-оркестратор прогона мониторинга — единственная точка входа чейна.
 * Cmd-файлы — тонкие shim'ы поверх этого скрипта: кодировка, локальный Node в PATH,
 * пауза при запуске из Проводника.
 *
 *   node scripts/monitor.mjs [конфиг] [ИМЯ=ЗНАЧЕНИЕ ...]
 *
 * Чейн: разбор аргументов → проверка окружения → снятие QuickEdit с интерактивной
 * консоли (клик-выделение иначе блокировало бы прогон) → валидация конфига → прогон
 * Playwright (`spawn` CLI, код возврата дочернего процесса = код оркестратора) →
 * перепроверка узлов с превышением порога → сборка отчёта (`buildReport` импортом, в
 * любом исходе).
 *
 * Коды возврата: 0 — основной прогон в норме; 1 — провал прогона, ошибка
 * конфига, ошибка отчёта или недопустимое значение переменной; 3 — окружение не готово,
 * нужен install.bat.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { checkEnvironment, BUNDLE_ROOT } from './check-env.mjs';

/**
 * Аргументы командной строки: первый позиционный аргумент — файл конфигурации
 * (по умолчанию env.json), остальные — ИМЯ=ЗНАЧЕНИЕ, уходящие в среду процесса на один
 * запуск. Значение с пробелами или & | < > ^ передаётся одним аргументом в кавычках;
 * двойная кавычка внутри значения не поддерживается.
 */
export function parseArgs(argv) {
  const args = [...argv];
  let configPath = '';
  if (args.length > 0 && !args[0].includes('=')) {
    configPath = args.shift();
  }
  const pairs = [];
  const bad = [];
  for (const token of args) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (m) {
      pairs.push([m[1], m[2]]);
    } else {
      bad.push(token);
    }
  }
  return { configPath, pairs, bad };
}

/**
 * Загрузка и проверка конфигурации. Проверки повторяют `helpers/config.ts` —
 * скрипты идут без сборки TypeScript, поэтому валидация продублирована текстом (тот же
 * приём, что пути в scripts/common.mjs). Текст ошибки называет поле; фрагмент исходника
 * JSON в ошибку не попадает — в конфиге пароль.
 */
export function loadMonitorConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `${configPath} не найден. Скопируйте env.example.json в env.json (или в env.<контур>.json ` +
        'и укажите его первым аргументом) и заполните.'
    );
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    throw new Error(`${configPath}: не удалось разобрать JSON — проверьте файл.`);
  }

  const field = (cond, message) => {
    if (!cond) {
      throw new Error(`${configPath}: ${message}`);
    }
  };

  field(typeof cfg === 'object' && cfg !== null && !Array.isArray(cfg), 'ожидался объект наверху уровня');
  field(typeof cfg.environment === 'string' && cfg.environment.trim() !== '', 'не задан environment — имя контура, под которым пишется статистика');
  field(typeof cfg.login === 'string' && cfg.login !== '', 'не заполнен login');
  field(typeof cfg.password === 'string' && cfg.password !== '', 'не заполнен password');
  field(typeof cfg.scenario === 'string' && cfg.scenario.trim() !== '', 'не задан scenario — имя файла сценария без расширения (specs/<scenario>.spec.ts)');
  if (typeof cfg.scenario === 'string' && cfg.scenario.trim() !== '') {
    // Имя становится частью пути: безопасный набор и существование файла — до прогона.
    field(
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(cfg.scenario),
      `scenario="${cfg.scenario}" недопустим — имя файла specs/<scenario>.spec.ts: латиница, цифры, дефис и подчёркивание`
    );
    const scenarioFile = path.resolve(BUNDLE_ROOT, 'specs', `${cfg.scenario}.spec.ts`);
    field(fs.existsSync(scenarioFile), `файл сценария specs/${cfg.scenario}.spec.ts не найден`);
  }

  field(cfg.targets !== null && typeof cfg.targets === 'object' && !Array.isArray(cfg.targets), 'не заданы targets — узлы контура (имя → URL точки входа)');
  if (cfg.targets) {
    const names = Object.keys(cfg.targets);
    field(names.length > 0, 'не задан ни один узел в targets');
    for (const name of names) {
      field(name.trim() !== '', 'в targets есть узел с пустым именем');
      field(typeof cfg.targets[name] === 'string' && cfg.targets[name].trim() !== '', `targets.${name} должен быть непустым URL точки входа`);
    }
  }

  field(cfg.thresholds !== null && typeof cfg.thresholds === 'object' && !Array.isArray(cfg.thresholds), 'не заданы thresholds — эталоны по именам метрик сценария');
  if (cfg.thresholds) {
    // Полноту по именам метрик знает только сценарий (сверяет specs/cabinet.ts при загрузке);
    // ядро проверяет саму таблицу: непустая, каждый порог — положительный { reference, maxRatio }.
    const metricNames = Object.keys(cfg.thresholds);
    field(metricNames.length > 0, 'thresholds пуст — для каждой метрики сценария нужен порог { reference, maxRatio }');
    for (const metric of metricNames) {
      const t = cfg.thresholds[metric];
      field(t !== null && typeof t === 'object', `thresholds.${metric} должен быть объектом { reference, maxRatio }`);
      if (t && typeof t === 'object') {
        field(typeof t.reference === 'number' && Number.isFinite(t.reference) && t.reference > 0, `thresholds.${metric}.reference должно быть положительным числом, получено ${JSON.stringify(t.reference)}`);
        field(typeof t.maxRatio === 'number' && Number.isFinite(t.maxRatio) && t.maxRatio > 0, `thresholds.${metric}.maxRatio должно быть положительным числом, получено ${JSON.stringify(t.maxRatio)}`);
      }
    }
  }

  return cfg;
}

/** Сообщения «окружение не готов» */
function printNotReady(result) {
  if (result.status === 'node-old') {
    console.error('[monitor] Node.js старше версии, требуемой package.json (engines.node).');
  } else if (result.status === 'deps-missing') {
    console.error('[monitor] Пакеты не установлены - нет node_modules.');
  } else if (result.status === 'deps-stale') {
    console.error('[monitor] Установленные пакеты не совпадают с package-lock.json.');
  } else if (result.status === 'browser-missing') {
    console.error('[monitor] Браузер Playwright не найден.');
  }
  console.error('[monitor] Запустите install.bat в этом каталоге.');
}

/**
 * Запуск прогона: `node node_modules\@playwright\test\cli.js test [extraArgs...]` из корня
 * бандла. stdio — inherit: консоль и цвета проходят сквозь, stdin отрезан (HTML-reporter
 * не ждёт ввода на подсказке «To open last HTML report»).
 * Код выхода дочернего процесса — код вызывающего чейна.
 */
function runPlaywright(extraArgs = []) {
  return new Promise(resolve => {
    const cliJs = path.join(BUNDLE_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
    const child = spawn(process.execPath, [cliJs, 'test', ...extraArgs], {
      cwd: BUNDLE_ROOT,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', e => {
      console.error(`[monitor] не удалось запустить Playwright: ${e.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`[monitor] прогон прерван сигналом ${signal}.`);
        resolve(1);
        return;
      }
      resolve(code === null ? 1 : code);
    });
  });
}

/**
 * `last-run-id.txt` и его отложенная копия `.prev`. Пути — та же формула, что в
 * `scripts/common.mjs`; дублируется текстом, потому что common.mjs вычисляет константы
 * при импорте — до того, как пары ИМЯ=ЗНАЧЕНИЕ попадут в среду.
 */
function runIdPaths() {
  const artifactsDir = path.resolve(BUNDLE_ROOT, process.env.MONITOR_ARTIFACTS?.trim() || 'artifacts');
  const runIdPath = path.join(artifactsDir, 'last-run-id.txt');
  return { runIdPath, prevPath: `${runIdPath}.prev` };
}

async function main() {
  const { configPath, pairs, bad } = parseArgs(process.argv.slice(2));

  for (const token of bad) {
    console.error(`[monitor] "${token}" не в форме ИМЯ=ЗНАЧЕНИЕ — передайте значение аргументом в кавычках целиком.`);
  }
  if (bad.length > 0) {
    process.exitCode = 1;
    return;
  }

  // Пары уходят в среду до проверок: проверяется то окружение, которое задал пользователь.
  for (const [name, value] of pairs) {
    process.env[name] = value;
  }
  if (configPath) {
    process.env.MONITOR_CONFIG = configPath;
  }

  // Окружение раньше конфига: код 3 «не готово» важнее код 1 «невалидно».
  const env = checkEnvironment(BUNDLE_ROOT);
  if (env.status !== 'ready') {
    printNotReady(env);
    process.exitCode = 3;
    return;
  }
  // Браузер внутри node_modules ищется Playwright только с PLAYWRIGHT_BROWSERS_PATH=0.
  if (env.browser === 'local' && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  }

  // QuickEdit: клик в окно с активным выделением блокирует запись в консоль и остановил бы
  // прогон до снятия выделения. В интерактивной консоли отключаем; сбой — предупреждение,
  // не причина останавливать прогон. Перепроверка — новый прогон в этом же процессе:
  // повторный вызов не нужен.
  if (process.platform === 'win32' && process.stdout.isTTY) {
    const { disableQuickEdit } = await import('./console-mode.mjs');
    const qe = disableQuickEdit();
    if (qe.ok) {
      console.log('[monitor] QuickEdit консоли отключён.');
    } else {
      console.error(`[monitor] QuickEdit не отключён (${qe.reason}) — клик в окно остановит вывод до ESC.`);
    }
  }

  const resolvedConfig = path.resolve(BUNDLE_ROOT, process.env.MONITOR_CONFIG?.trim() || 'env.json');
  try {
    loadMonitorConfig(resolvedConfig);
  } catch (e) {
    console.error(`[monitor] ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // Прошлый id откладывается: прогон, упавший до globalSetup, не должен оставить файл
  // подменённым, иначе отчёт построился бы по прошлому прогону как по текущему.
  const { runIdPath, prevPath } = runIdPaths();
  if (fs.existsSync(runIdPath)) {
    fs.rmSync(prevPath, { force: true });
    fs.renameSync(runIdPath, prevPath);
  }

  const runCode = await runPlaywright();

  if (!fs.existsSync(runIdPath)) {
    // Прогон не дошёл до замеров: id не появился — отчёт не строится (иначе показал бы
    // прошлый прогон), файл id возвращается как было.
    if (fs.existsSync(prevPath)) {
      fs.renameSync(prevPath, runIdPath);
    }
    console.error('[monitor] Прогон не дошёл до замеров — отчёт не строится. Причина — в выводе выше.');
    process.exitCode = runCode === 0 ? 1 : runCode;
    return;
  }
  fs.rmSync(prevPath, { force: true });

  // --- Перепроверка медленных узлов ------------------------------------------
  // Узлы со строками verdict=slow основного прогона идут повторно под id
  // `<run_id>-recheck`: только они, через --project, с MONITOR_RECHECK_OF — у прогона
  // свои json/html-выходы (playwright.config.ts), основные не затираются.
  // last-run-id.txt перепроверка не трогает (globalSetup пишет его только основному).
  // Итог и код возврата — только от основного прохода; сбой перепроверки справочен.
  const mainRunId = fs.readFileSync(runIdPath, 'utf-8').trim();
  try {
    const { slowTargets } = await import('./slow-targets.mjs');
    const targets = slowTargets(mainRunId);
    if (targets.length > 0) {
      console.log(`[monitor] Перепроверка узлов с превышением порога: ${targets.join(', ')}`);
      process.env.MONITOR_RUN_ID = `${mainRunId}-recheck`;
      process.env.MONITOR_RECHECK_OF = mainRunId;
      await runPlaywright(targets.map(t => `--project=${t}`));
    }
  } catch (e) {
    console.error(`[monitor] перепроверка не выполнена: ${e.message}`);
  }

  // Отчёт — после прогона и перепроверки, в любом их исходе. Импорт здесь,
  // после применения пар: common.mjs внутри report.mjs вычисляет пути при загрузке модуля.
  let reportCode = 0;
  try {
    const { buildReport } = await import('./report.mjs');
    reportCode = buildReport();
  } catch (e) {
    console.error(`[monitor] отчёт не построен: ${e.message}`);
    reportCode = 1;
  }

  process.exitCode = runCode !== 0 ? runCode : reportCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
