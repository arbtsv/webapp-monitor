/**
 * Готовность каталога к прогону — одна проверка для оркестратора и `install.bat`. Ничего не
 * пишет и не ходит в сеть.
 *
 * Синтаксис ES2019, без `?.`/`??`: старый Node должен ответить `node-old`, а не упасть на
 * SyntaxError. Только встроенные модули — `node_modules` здесь и проверяется.
 *
 * Потребители двое: Node-оркестратор импортирует `checkEnvironment`, `install.bat` зовёт
 * этот файл как CLI. CLI-обёртка печатает в stdout четыре строки:
 *   STATUS=<ready|node-old|deps-missing|deps-stale|browser-missing>
 *   NODE=<process.version>
 *   DEPS=<ok|missing|stale>
 *   BROWSER=<local|global|missing>
 * Код 0 только при STATUS=ready. Приоритет STATUS: node-old > deps-missing >
 * deps-stale > browser-missing > ready.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

export const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Минимальная major-версия — первое число в `engines.node`; нет — `null` (без ограничения). */
function readRequiredNodeMajor(bundleRoot) {
  var pkgPath = path.join(bundleRoot, 'package.json');
  var pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }
  var range = pkg && pkg.engines && pkg.engines.node;
  if (!range) {
    return null;
  }
  var m = /(\d+)/.exec(range);
  if (!m) {
    return null;
  }
  return parseInt(m[1], 10);
}

function currentNodeMajor() {
  var parts = process.versions.node.split('.');
  return parseInt(parts[0], 10);
}

/**
 * `missing` — нет `@playwright/test`. Иначе версия каждого пакета из `package-lock.json`
 * сверяется с установленной; записи не для этой платформы и отсутствующие `optional`
 * пропускаются. Любое расхождение — `stale`.
 */
function checkDeps(bundleRoot) {
  var nodeModulesDir = path.join(bundleRoot, 'node_modules');
  var playwrightTestPkg = path.join(nodeModulesDir, '@playwright', 'test', 'package.json');
  if (!fs.existsSync(playwrightTestPkg)) {
    return 'missing';
  }
  var lockPath = path.join(bundleRoot, 'package-lock.json');
  var lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  } catch {
    return 'stale';
  }
  var packages = lock.packages || {};
  var keys = Object.keys(packages);
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    if (key.indexOf('node_modules/') !== 0) {
      continue;
    }
    var rel = key.slice('node_modules/'.length);
    if (!rel) {
      continue;
    }
    var entry = packages[key];
    if (entry.os && entry.os.indexOf(process.platform) === -1) {
      continue;
    }
    if (entry.cpu && entry.cpu.indexOf(process.arch) === -1) {
      continue;
    }
    var dir = path.join(nodeModulesDir, rel);
    if (entry.optional && !fs.existsSync(dir)) {
      continue;
    }
    var installedVersion = null;
    try {
      installedVersion = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version;
    } catch {
      installedVersion = null;
    }
    if (installedVersion !== entry.version) {
      return 'stale';
    }
  }
  return 'ok';
}

/** Та же логика `PLAYWRIGHT_BROWSERS_PATH`, что у Playwright, — иначе проверка и запуск разошлись бы. */
function checkBrowser(bundleRoot) {
  var browsersJsonPath = path.join(bundleRoot, 'node_modules', 'playwright-core', 'browsers.json');
  var browsersJson;
  try {
    browsersJson = JSON.parse(fs.readFileSync(browsersJsonPath, 'utf-8'));
  } catch {
    return 'missing';
  }
  var list = browsersJson.browsers || [];
  var entry = null;
  for (var i = 0; i < list.length; i += 1) {
    if (list[i].name === 'chromium-headless-shell') {
      entry = list[i];
      break;
    }
  }
  if (!entry) {
    return 'missing';
  }
  var dirName = 'chromium_headless_shell-' + entry.revision;

  var envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  var envSet = typeof envPath === 'string' && envPath !== '';

  if (envSet && envPath !== '0') {
    var explicitDir = path.resolve(process.cwd(), envPath);
    var explicitMarker = path.join(explicitDir, dirName, 'INSTALLATION_COMPLETE');
    return fs.existsSync(explicitMarker) ? 'global' : 'missing';
  }

  var localMarker = path.join(bundleRoot, 'node_modules', 'playwright-core', '.local-browsers', dirName, 'INSTALLATION_COMPLETE');
  if (fs.existsSync(localMarker)) {
    return 'local';
  }
  if (envSet && envPath === '0') {
    return 'missing';
  }

  var localAppData = process.env.LOCALAPPDATA;
  var localAppDataBase = localAppData && localAppData !== '' ? localAppData : path.join(os.homedir(), 'AppData', 'Local');
  var globalMarker = path.join(localAppDataBase, 'ms-playwright', dirName, 'INSTALLATION_COMPLETE');
  return fs.existsSync(globalMarker) ? 'global' : 'missing';
}

/**
 * Проверка готовности `bundleRoot` к прогону. Возвращает `{ status, node, deps, browser }`,
 * где `status` — итог по приоритету node-old > deps-missing > deps-stale >
 * browser-missing > ready. Без побочных эффектов: ничего не пишет и не меняет среду.
 */
export function checkEnvironment(bundleRoot) {
  var requiredMajor = readRequiredNodeMajor(bundleRoot);
  var nodeOld = requiredMajor !== null && currentNodeMajor() < requiredMajor;
  var deps = checkDeps(bundleRoot);
  var browser = checkBrowser(bundleRoot);

  var status;
  if (nodeOld) {
    status = 'node-old';
  } else if (deps === 'missing') {
    status = 'deps-missing';
  } else if (deps === 'stale') {
    status = 'deps-stale';
  } else if (browser === 'missing') {
    status = 'browser-missing';
  } else {
    status = 'ready';
  }

  return { status: status, node: process.version, deps: deps, browser: browser };
}

/** CLI-обёртка: четыре строки `KEY=значение` и код 0 только при STATUS=ready. */
function main() {
  var result = checkEnvironment(BUNDLE_ROOT);

  process.stdout.write('STATUS=' + result.status + '\n');
  process.stdout.write('NODE=' + result.node + '\n');
  process.stdout.write('DEPS=' + result.deps + '\n');
  process.stdout.write('BROWSER=' + result.browser + '\n');

  process.exitCode = result.status === 'ready' ? 0 : 1;
}

// Импорт из оркестратора не должен печатать: обёртка работает только при прямом запуске.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
