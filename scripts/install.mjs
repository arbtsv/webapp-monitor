#!/usr/bin/env node
/**
 * Оркестратор установки — единственная точка входа логики установщика.
 * Cmd-файл — тонкий ASCII shim (кодировка, детект Проводника, bootstrap Node при
 * его отсутствии, пауза): см. заголовок install.bat.
 *
 *   node scripts/install.mjs [/y] [/reinstall] [/?]
 *
 * Коды возврата (неизменны): 0 — готово; 1 — сбой шага;
 * 2 — нет согласия, неизвестный ключ, справка.
 *
 * Чистые функции (`parseInstallArgs`, `decidePlan`, `detectConsoleCp`, `nodeBase`)
 * экспортированы для офлайн-юнитов (tests/install.unit.ts): логика
 * проверяется без сети и без прогона установки.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { checkEnvironment, BUNDLE_ROOT } from './check-env.mjs';
import { selectMessages } from './install-messages.mjs';

/** Пин версии Node.js — дублирует константу в install.bat (bootstrap качает именно её). */
export const NODE_VERSION = '24.21.0';

// ---------------------------------------------------------------------------
// Чистые функции (без побочных эффектов) — покрыты tests/install.unit.ts.
// ---------------------------------------------------------------------------

/**
 * Разбор аргументов: `/y` — согласие без вопроса, `/reinstall` —
 * снос и переустановка без вопроса, `/?` — справка, иное — неизвестный ключ (код 2
 * со справкой). Регистр не важен. Любой неизвестный ключ отменяет всё: первый
 * неизвестный токен уводит на справку.
 *
 * Возвращает `{ key: 'none'|'y'|'reinstall'|'help'|'unknown', unknown: string|null }`.
 */
export function parseInstallArgs(argv) {
  let key = 'none';
  let unknown = null;
  for (const token of argv) {
    const lower = token.toLowerCase();
    if (lower === '/y') {
      if (key === 'none') {
        key = 'y';
      }
    } else if (lower === '/reinstall') {
      key = 'reinstall';
    } else if (lower === '/?') {
      key = 'help';
    } else if (unknown === null) {
      unknown = token;
    }
  }
  if (unknown !== null) {
    return { key: 'unknown', unknown };
  }
  return { key, unknown: null };
}

/**
 * План установки по снимку окружения: что сносить и какие шаги выполнять.
 * «Качается только недостающее». После `/reinstall` шагов всегда три: снос убирает
 * node\ вместе с браузером внутри node_modules\.
 *
 * `env` — `{ localNodeOk, deps, browser }` как у `checkEnvironment()` плюс признак
 * локального Node: `deps`/`browser` — 'ok'|'missing'|'stale' и 'local'|'global'|'missing'.
 * Возвращает `{ wipe, steps, ready }`; `steps` — подмножество
 * ['node-download', 'npm-ci', 'browser'] в порядке исполнения.
 */
export function decidePlan(env, key) {
  if (key === 'reinstall') {
    return { wipe: true, steps: ['node-download', 'npm-ci', 'browser'], ready: false };
  }
  const steps = [];
  if (!env.localNodeOk) {
    steps.push('node-download');
  }
  if (env.deps !== 'ok') {
    steps.push('npm-ci');
  }
  if (env.browser !== 'local') {
    steps.push('browser');
  }
  return { wipe: false, steps, ready: steps.length === 0 };
}

/**
 * Реальная кодовая страница консоли процесса: `chcp` без аргументов. Возвращает
 * число (например 65001) или null при сбое — селектор сообщений трактует null как
 * «транслит» (безопасная сторона). Опрашивает stderr тоже: chcp печатает
 * туда в не-Unicode консолях.
 */
export function detectConsoleCp() {
  const r = spawnSync('cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'utf8' });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /(\d+)/.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * База загрузки Node.js: зеркало `MONITOR_NODE_MIRROR` без хвостового `/` или
 * официальный dist. Пустое значение зеркала — как незаданное.
 */
export function nodeBase(env) {
  const mirror = (env.MONITOR_NODE_MIRROR || '').trim();
  if (!mirror) {
    return 'https://nodejs.org/dist';
  }
  return mirror.endsWith('/') ? mirror.slice(0, -1) : mirror;
}

// ---------------------------------------------------------------------------
// Исполнение установки.
// ---------------------------------------------------------------------------

function fail(t, message) {
  console.log(`[install] ${message}`);
  return 1;
}

/** Решение согласия по ответу: y/Y (любой регистр, краевые пробелы) — да; пусто — defaultYes; иное — нет. */
export function consentFromAnswer(answer, defaultYes = false) {
  const a = answer.trim().toLowerCase();
  return a === 'y' || (a === '' && defaultYes);
}

/** Спросить согласие в интерактивной консоли: Enter — defaultYes, EOF/иное — «нет». */
function askConsent(question, stdin, defaultYes = false) {
  return new Promise(resolve => {
    process.stdout.write(question);
    let buf = '';
    stdin.setEncoding('utf8');
    stdin.on('data', chunk => {
      buf += chunk;
      const nl = buf.search(/[\r\n]/);
      if (nl !== -1) {
        stdin.pause();
        resolve(consentFromAnswer(buf.slice(0, nl), defaultYes));
      }
    });
    // EOF без строки — не согласие: закрытый stdin (планировщик) не должен качать молча.
    stdin.on('end', () => resolve(false));
    stdin.on('error', () => resolve(false));
  });
}

/**
 * Снос node\, node_modules\ и .install-tmp\. Отказ — код 1 с причиной,
 * файлы не тронуты: нет package.json с маркером webapp-monitor, node\ или
 * node_modules\ — ссылка, каталог занят.
 */
export function wipe(bundleRoot, t) {
  const pkgPath = path.join(bundleRoot, 'package.json');
  let pkgText;
  try {
    pkgText = fs.readFileSync(pkgPath, 'utf-8');
  } catch {
    pkgText = null;
  }
  if (pkgText === null) {
    return fail(t, t('wipe.no-package-json'));
  }
  if (!pkgText.includes('webapp-monitor')) {
    return fail(t, t('wipe.not-webapp-monitor'));
  }
  for (const name of ['node', 'node_modules']) {
    const target = path.join(bundleRoot, name);
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        return fail(t, t('wipe.link-refuse'));
      }
    } catch {
      // Нет такого пути — не ссылка, продолжаем.
    }
  }
  for (const [name, busyKey] of [
    ['node', 'wipe.node-busy'],
    ['node_modules', 'wipe.node-modules-busy']
  ]) {
    const target = path.join(bundleRoot, name);
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        return fail(t, t(busyKey));
      }
      if (fs.existsSync(target)) {
        return fail(t, t(busyKey));
      }
    }
  }
  fs.rmSync(path.join(bundleRoot, '.install-tmp'), { recursive: true, force: true });
  return 0;
}

/** Браузер из .install-tmp\ на место, если его место пусто (переждал npm ci). */
function restoreLocalBrowsers(bundleRoot) {
  const saved = path.join(bundleRoot, '.install-tmp', 'local-browsers');
  const place = path.join(bundleRoot, 'node_modules', 'playwright-core', '.local-browsers');
  if (!fs.existsSync(saved)) {
    return;
  }
  if (!fs.existsSync(path.join(bundleRoot, 'node_modules', 'playwright-core', 'package.json'))) {
    return;
  }
  if (fs.existsSync(place)) {
    return;
  }
  fs.mkdirSync(path.dirname(place), { recursive: true });
  try {
    fs.renameSync(saved, place);
  } catch {
    fs.cpSync(saved, place, { recursive: true });
    fs.rmSync(saved, { recursive: true, force: true });
  }
}

/** Спрятать локальный браузер в .install-tmp\ перед npm ci. */
function stashLocalBrowsers(bundleRoot) {
  const place = path.join(bundleRoot, 'node_modules', 'playwright-core', '.local-browsers');
  const saved = path.join(bundleRoot, '.install-tmp', 'local-browsers');
  if (!fs.existsSync(place)) {
    return;
  }
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.rmSync(saved, { recursive: true, force: true });
  try {
    fs.renameSync(place, saved);
  } catch {
    fs.cpSync(place, saved, { recursive: true });
    fs.rmSync(place, { recursive: true, force: true });
  }
}

/** Выполнить команду с выводом в консоль; вернуть код выхода. */
function run(cmd, args, options) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...options });
    child.on('error', () => resolve(1));
    child.on('close', code => resolve(code === null ? 1 : code));
  });
}

/** Шаг node-download: curl, сверка SHA-256, tar, перенос в node\. */
async function downloadNode(bundleRoot, base, t) {
  const archive = `node-v${NODE_VERSION}-win-x64.zip`;
  const downloadDir = path.join(bundleRoot, '.install-tmp', 'download');
  const extractDir = path.join(bundleRoot, '.install-tmp', 'extract');
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true });

  // Флаги вывода — в вызове: бар (--progress-bar) на большом архиве вместо таблицы meter,
  // тихий режим (-sS) на крошечном SHASUMS — два бара под одним заголовком читаются как сбой.
  const curl = (out, url, ...extra) =>
    run(process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\curl.exe` : 'curl.exe', [
      '-f',
      '-L',
      '--retry',
      '2',
      ...extra,
      '-o',
      out,
      url
    ]);

  console.log(`[install] ${t('step.node-start', NODE_VERSION)}`);
  if (
    (await curl(
      path.join(downloadDir, 'SHASUMS256.txt'),
      `${base}/v${NODE_VERSION}/SHASUMS256.txt`,
      '-sS'
    )) !== 0
  ) {
    return fail(t, t('step.node-download-failed', 'SHASUMS256.txt'));
  }
  if (
    (await curl(path.join(downloadDir, archive), `${base}/v${NODE_VERSION}/${archive}`, '--progress-bar')) !==
    0
  ) {
    return fail(t, t('step.node-download-failed', archive));
  }

  let expectedSha = null;
  const shaLines = fs.readFileSync(path.join(downloadDir, 'SHASUMS256.txt'), 'utf-8').split(/\r?\n/);
  for (const line of shaLines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === archive) {
      expectedSha = parts[0].toLowerCase();
      break;
    }
  }
  if (expectedSha === null) {
    fs.rmSync(path.join(downloadDir, archive), { force: true });
    return fail(t, t('step.node-sha-missing', archive));
  }

  const certutil = spawnSync(
    process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\certutil.exe` : 'certutil.exe',
    ['-hashfile', path.join(downloadDir, archive), 'SHA256'],
    { encoding: 'utf8' }
  );
  const actualSha = /([0-9a-f]{64})/i.exec(`${certutil.stdout || ''}${certutil.stderr || ''}`);
  if (!actualSha || actualSha[1].toLowerCase() !== expectedSha) {
    fs.rmSync(path.join(downloadDir, archive), { force: true });
    return fail(t, t('step.node-sha-mismatch'));
  }

  fs.mkdirSync(extractDir, { recursive: true });
  const tar = spawnSync(
    process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\tar.exe` : 'tar.exe',
    ['-xf', path.join(downloadDir, archive), '-C', extractDir],
    { stdio: 'inherit' }
  );
  if (tar.status !== 0) {
    return fail(t, t('step.node-unpack-failed'));
  }
  const unpacked = path.join(extractDir, `node-v${NODE_VERSION}-win-x64`);
  if (!fs.existsSync(path.join(unpacked, 'node.exe'))) {
    return fail(t, t('step.node-no-exe'));
  }
  const nodeDir = path.join(bundleRoot, 'node');
  if (fs.existsSync(nodeDir)) {
    fs.rmSync(nodeDir, { recursive: true, force: true });
    if (fs.existsSync(nodeDir)) {
      return fail(t, t('step.node-busy'));
    }
  }
  try {
    fs.renameSync(unpacked, nodeDir);
  } catch {
    return fail(t, t('step.node-move-failed'));
  }
  if (!fs.existsSync(path.join(nodeDir, 'node.exe'))) {
    return fail(t, t('step.node-move-failed'));
  }
  const version = spawnSync(path.join(nodeDir, 'node.exe'), ['--version'], { encoding: 'utf8' });
  if ((version.stdout || '').trim() !== `v${NODE_VERSION}`) {
    return fail(t, t('step.node-version-unexpected', (version.stdout || '').trim()));
  }
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  return 0;
}

/** Печать справки (/?, неизвестный ключ) — код 2. */
function printUsage(t) {
  console.log(t('usage.line1'));
  console.log(t('usage.y'));
  console.log(t('usage.reinstall'));
  console.log(t('usage.help'));
  return 2;
}

/** Точка входа. Возвращает код возврата; при прямом запуске — process.exitCode. */
export async function runInstall(argv, io = {}) {
  const stdin = io.stdin || process.stdin;
  const interactive = Boolean(stdin.isTTY);
  const { key, unknown } = parseInstallArgs(argv);
  const messages = selectMessages(detectConsoleCp());
  const t = messages.t;

  if (key === 'unknown') {
    console.log(`[install] ${t('key.unknown', unknown)}`);
    return printUsage(t);
  }
  if (key === 'help') {
    return printUsage(t);
  }

  const bundleRoot = BUNDLE_ROOT;
  // Браузер — внутри пакета, не в LOCALAPPDATA.
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

  // Без ключей и без консоли — вопрос не задаётся, ввод не читается, подсказка
  // и код 2. Безусловно, в том числе на готовом окружении: единственное
  // осмысленное действие оттуда — /reinstall.
  if (key === 'none' && !interactive) {
    console.log(`[install] ${t('consent.no-console')}`);
    return 2;
  }

  if (key === 'reinstall') {
    const rc = wipe(bundleRoot, t);
    if (rc !== 0) {
      return rc;
    }
    restoreLocalBrowsers(bundleRoot);
  }

  let env = checkEnvironment(bundleRoot);
  let plan = decidePlan(
    { localNodeOk: process.version === `v${NODE_VERSION}`, deps: env.deps, browser: env.browser },
    key
  );

  if (plan.ready) {
    // /y на готовом окружении: ничего не сносим, отчёт и код 0 (контракт /y).
    if (key === 'y') {
      console.log(`[install] ${t('ready.already')}`);
      return 0;
    }
    // Сюда доходим только интерактивно и без ключей: без консоли уже вышли выше,
    // /reinstall готового плана не оставляет (снёс окружение перед планом).
    console.log(`[install] ${t('ready.already')}`);
    console.log(`[install] ${t('ready.reinstall-header')}`);
    console.log(`[install] ${t('plan.item-node', NODE_VERSION)}`);
    console.log(`[install] ${t('plan.item-npm')}`);
    console.log(`[install] ${t('plan.item-browser')}`);
    const consent = await askConsent(t('ready.ask-reinstall'), stdin, true); // Enter — продолжить, как в consent.ask
    if (!consent) {
      return 0;
    }
    const rc = wipe(bundleRoot, t);
    if (rc !== 0) {
      return rc;
    }
    restoreLocalBrowsers(bundleRoot);
    env = checkEnvironment(bundleRoot);
    plan = decidePlan(
      { localNodeOk: process.version === `v${NODE_VERSION}`, deps: env.deps, browser: env.browser },
      'reinstall'
    );
  } else if (key === 'y') {
    // /y на неготовом окружении — план без вопроса; на готовом — выше,
    // plan.ready, сюда не попадаем: /y ничего не сносит и не переустанавливает.
  } else {
    // Интерактивный запуск без ключей на неготовом окружении: план, вопрос, отказ — 2.
    const showNode = plan.steps.includes('node-download');
    const showNpm = plan.steps.includes('npm-ci');
    const showBrowser = plan.steps.includes('browser');
    console.log(`[install] ${t('plan.header')}`);
    if (showNode) {
      console.log(`[install] ${t('plan.item-node', NODE_VERSION)}`);
    }
    if (showNpm) {
      console.log(`[install] ${t('plan.item-npm')}`);
    }
    if (showBrowser) {
      console.log(`[install] ${t(showNpm ? 'plan.item-browser-maybe' : 'plan.item-browser')}`);
    }
    console.log(`[install] ${t('plan.into', bundleRoot)}`);
    const consent = await askConsent(t('consent.ask'), stdin, true); // Enter — согласие: раскладка не важна
    if (!consent) {
      console.log(`[install] ${t('consent.cancelled')}`);
      return 2;
    }
  }

  // Шаги — строго по плану, сбой шага сразу код 1 с именем шага (ретраи запрещены).
  if (plan.steps.includes('node-download')) {
    const base = nodeBase(process.env);
    const rc = await downloadNode(bundleRoot, base, t);
    if (rc !== 0) {
      return rc;
    }
    // Локальный Node только что появился — дальше под ним этот же процесс не живёт:
    // шаги npm ci/браузер вызывают node из node\ через spawn.
    env = checkEnvironment(bundleRoot);
    if (env.deps === 'ok' && env.browser === 'local') {
      plan = { wipe: false, steps: [], ready: true };
    } else {
      plan = decidePlan({ localNodeOk: true, deps: env.deps, browser: env.browser }, 'none');
    }
  }

  if (plan.steps.includes('npm-ci')) {
    stashLocalBrowsers(bundleRoot);
    console.log(`[install] ${t('step.npm-start')}`);
    // npm.cmd — батник: без shell CreateProcess его не поднимает.
    const npmRc = await run('npm.cmd', ['ci', '--include=dev', '--no-audit', '--no-fund'], {
      shell: true,
      env: { ...process.env, PATH: `${path.join(bundleRoot, 'node')};${process.env.PATH}` }
    });
    restoreLocalBrowsers(bundleRoot);
    if (npmRc !== 0) {
      return fail(t, t('step.npm-failed', npmRc));
    }
    env = checkEnvironment(bundleRoot);
    if (env.deps !== 'ok') {
      return fail(t, t('step.deps-still-wrong'));
    }
  }

  if (plan.steps.includes('browser')) {
    console.log(`[install] ${t('step.browser-start')}`);
    const browserRc = await run(
      process.execPath,
      [
        path.join(bundleRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
        'install',
        '--only-shell',
        'chromium'
      ],
      { env: process.env }
    );
    if (browserRc !== 0) {
      return fail(t, t('step.browser-failed'));
    }
  }

  env = checkEnvironment(bundleRoot);
  if (env.status !== 'ready') {
    return fail(t, t('final.not-ready', env.status));
  }
  fs.rmSync(path.join(bundleRoot, '.install-tmp'), { recursive: true, force: true });
  console.log(`[install] ${t('final.done')}`);
  return 0;
}

// Импорт из тестов не должен запускать установку: main только при прямом запуске.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInstall(process.argv.slice(2)).then(
    rc => {
      process.exitCode = rc;
    },
    err => {
      console.error(err);
      process.exitCode = 1;
    }
  );
}
