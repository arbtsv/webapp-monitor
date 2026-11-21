#!/usr/bin/env node
/**
 * Обвязка shim-случаев `install.bat`: баг chcp 65001 + не-ASCII при запуске
 * не из живой консоли). Bat — чисто ASCII: кодировка консоли, bootstrap Node при его
 * отсутствии, делегирование `scripts\install.mjs %*`, пауза из Проводника. Здесь
 * контроль этих граней без сети и без node_modules бандла.
 *
 * Случаи:
 *   1. `ascii`        — install.bat не содержит байтов >127.
 *   2. `pass-through` — argv доезжает до оркестратора целиком (заглушка фиксирует
 *                       argv и кодовую страницу консоли — 65001).
 *   3. `exit-codes`   — код заглушки 0/1/2 пробрасывается вызывающему как есть.
 *   4. `no-console`   — настоящий оркестратор со stdin `< nul`/pipe: без ключей
 *                       подсказка и код 2, `/?` — справка и код 2; ввод
 *                       не читается, сеть не трогается (выход до шагов).
 *   5. `explorer-pause` — строка Проводника: после оркестратора процесс ждёт клавишу;
 *                       ответ по stdin разблокирует, код сохранён. Строка консоли —
 *                       без паузы, выходит сам.
 *   6. `bootstrap-fail` — без node\ и с недоступным зеркалом bootstrap падает кодом 1
 *                       с читаемой английской причиной, без мусорных команд.
 *
 * Запуск: `npm run test:install-bat` или `node ./tests/install-bat.mjs` из каталога
 * бандла. Коды: 0 — все случаи OK; 1 — хотя бы один FAIL; 2 — сбой самой обвязки
 * (причина — строкой `[install-bat] …`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

if (process.platform !== 'win32') {
  console.error('[install-bat] доступно только на win32 (install.bat — cmd-скрипт)');
  process.exit(2);
}

const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES_ROOT = path.join(BUNDLE_ROOT, 'artifacts', '_dev', 'install-bat');
const BAT_PATH = path.join(BUNDLE_ROOT, 'install.bat');
// Скрипты настоящего оркестратора — для случая без заглушки.
const REAL_SCRIPTS = ['install.mjs', 'install-messages.mjs', 'check-env.mjs'];

/** Строка вида Проводника: вся командная строка в кавычках и пробел в конце. */
function explorerLine(batPath) {
  return '"' + `"${batPath}"` + ' "';
}

/** Свежая копия каталога случая: настоящий install.bat и заглушка оркестратора. */
function makeCaseDir(name, { realOrchestrator = false } = {}) {
  const dir = path.join(CASES_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(BAT_PATH, path.join(dir, 'install.bat'));
  // Локальный Node: копия системного — иначе shim уходит в bootstrap с сетью.
  fs.mkdirSync(path.join(dir, 'node'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(dir, 'node', 'node.exe'));
  if (realOrchestrator) {
    for (const name of REAL_SCRIPTS) {
      fs.copyFileSync(path.join(BUNDLE_ROOT, 'scripts', name), path.join(dir, 'scripts', name));
    }
  } else {
    fs.writeFileSync(
      path.join(dir, 'scripts', 'install.mjs'),
      [
        '// Заглушка оркестратора: фиксирует argv, среду и кодовую страницу для обвязки.',
        "import * as fs from 'fs';",
        "import { spawnSync } from 'child_process';",
        'const dump = process.env.INSTALL_BAT_DUMP;',
        "const cp = spawnSync('cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'utf8' });",
        'fs.writeFileSync(',
        '  dump,',
        '  JSON.stringify({',
        '    argv: process.argv.slice(2),',
        "    codepage: (cp.stdout || cp.stderr || '').trim(),",
        '    stdinIsTty: Boolean(process.stdin.isTTY),',
        '  })',
        ');',
        'process.exit(Number(process.env.STUB_EXIT_CODE || 0));',
        ''
      ].join('\n'),
      'utf-8'
    );
  }
  return dir;
}

/** Среда случая: без MONITOR_* оболочки (кроме заданных), с путём dump. */
function caseEnv(dir, extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('MONITOR_')) {
      env[name] = value;
    }
  }
  env.INSTALL_BAT_DUMP = path.join(dir, 'dump.json');
  Object.assign(env, extra);
  return env;
}

/** Одна проверка: проблемы — в массив; пусто — случай зелёный. */
function check(name, problems, fn) {
  try {
    fn();
  } catch (e) {
    problems.push(`${name}: ${e.message}`);
  }
}

function readDump(dir) {
  const p = path.join(dir, 'dump.json');
  if (!fs.existsSync(p)) {
    throw new Error('dump.json не создан — оркестратор не вызван');
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

/** Запуск bat строкой cmd /c "<bat> <args…>": кавычки как у Проводника. */
function runBat(dir, batName, args, options = {}) {
  const { env: extraEnv, ...rest } = options;
  const line = '"' + [`"${path.join(dir, batName)}"`, ...args.map(a => `"${a}"`)].join(' ') + '"';
  return spawnSync('cmd.exe', ['/d', '/c', line], {
    cwd: dir,
    env: caseEnv(dir, extraEnv),
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    timeout: 60000,
    ...rest
  });
}

// --- Случаи ---------------------------------------------------------------

function caseAscii() {
  const problems = [];
  check('байты', problems, () => {
    const buf = fs.readFileSync(BAT_PATH);
    const bad = [];
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] > 127) {
        bad.push(i);
      }
    }
    if (bad.length > 0) {
      throw new Error(`не-ASCII байты на смещениях ${bad.slice(0, 5).join(', ')}`);
    }
  });
  return problems;
}

function casePassThrough() {
  const problems = [];
  const dir = makeCaseDir('pass-through');
  const r = runBat(dir, 'install.bat', ['/y', 'marker=hello world']);
  check('код', problems, () => {
    if (r.status !== 0) {
      throw new Error(`ожидался 0, получен ${r.status}: ${r.stderr || ''}`);
    }
  });
  check('argv и кодировка', problems, () => {
    const dump = readDump(dir);
    const expected = ['/y', 'marker=hello world'];
    if (JSON.stringify(dump.argv) !== JSON.stringify(expected)) {
      throw new Error(`argv ${JSON.stringify(dump.argv)} != ${JSON.stringify(expected)}`);
    }
    if (!String(dump.codepage).includes('65001')) {
      throw new Error(`консоль не в UTF-8: chcp отвечает «${dump.codepage}»`);
    }
  });
  return problems;
}

// Проброс кода во всех режимах запуска: консоль, pipe, Проводник.
async function caseExitCodes() {
  const problems = [];
  const dir = makeCaseDir('exit-codes');
  for (const code of [0, 1, 2]) {
    const r = runBat(dir, 'install.bat', [], { env: { STUB_EXIT_CODE: String(code) } });
    check(`код ${code} (консоль)`, problems, () => {
      if (r.status !== code) {
        throw new Error(`ожидался ${code}, получен ${r.status}: ${r.stderr || ''}`);
      }
    });
    const rp = runBat(dir, 'install.bat', [], {
      input: '',
      env: { STUB_EXIT_CODE: String(code) }
    });
    check(`код ${code} (pipe)`, problems, () => {
      if (rp.status !== code) {
        throw new Error(`ожидался ${code}, получен ${rp.status}`);
      }
    });
  }
  // Проводник: после клавиши код сохранён.
  const batPath = path.join(dir, 'install.bat');
  const env = caseEnv(dir, { STUB_EXIT_CODE: '1' });
  const explorer = spawn('cmd.exe', ['/d', '/c', explorerLine(batPath)], {
    cwd: dir,
    env,
    windowsVerbatimArguments: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const rc = await new Promise(resolve => {
    const wait = setInterval(() => {
      if (fs.existsSync(path.join(dir, 'dump.json'))) {
        clearInterval(wait);
        explorer.stdin.write('x\n');
      }
    }, 100);
    explorer.on('exit', code => resolve(code));
  });
  check('код 1 (Проводник)', problems, () => {
    if (rc !== 1) {
      throw new Error(`ожидался 1, получен ${rc}`);
    }
  });
  return problems;
}

function caseNoConsole() {
  const problems = [];
  const dir = makeCaseDir('no-console', { realOrchestrator: true });

  // Без ключей, stdin = pipe с немедленным EOF: подсказка и код 2, ввод не читается.
  const r = runBat(dir, 'install.bat', [], { input: '' });
  check('код 2 без ключей', problems, () => {
    if (r.status !== 2) {
      throw new Error(`ожидался 2, получен ${r.status}: ${r.stdout || ''}${r.stderr || ''}`);
    }
  });
  check('подсказка про /y', problems, () => {
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (!out.includes('install.bat /y')) {
      throw new Error(`подсказка не найдена, вывод: ${out.slice(0, 200)}`);
    }
  });

  // /? из-под pipe: справка, код 2.
  const rh = runBat(dir, 'install.bat', ['/?'], { input: '' });
  check('код 2 у /?', problems, () => {
    if (rh.status !== 2) {
      throw new Error(`ожидался 2, получен ${rh.status}`);
    }
  });
  check('справка напечатана', problems, () => {
    if (!`${rh.stdout || ''}`.includes('/reinstall')) {
      throw new Error('справка не найдена в выводе');
    }
  });
  return problems;
}

async function caseExplorerPause() {
  const problems = [];
  const dir = makeCaseDir('explorer-pause');
  const batPath = path.join(dir, 'install.bat');
  const env = caseEnv(dir);

  // Проводник: хвостовой пробел — пауза ждёт клавишу.
  const explorer = spawn('cmd.exe', ['/d', '/c', explorerLine(batPath)], {
    cwd: dir,
    env,
    windowsVerbatimArguments: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let explorerOut = '';
  explorer.stdout.on('data', c => {
    explorerOut += c;
  });
  const exitedBeforeKey = await new Promise(resolve => {
    let done = false;
    explorer.on('exit', () => {
      if (!done) {
        done = true;
        resolve(true);
      }
    });
    const waitDump = setInterval(() => {
      if (done) {
        clearInterval(waitDump);
        return;
      }
      if (fs.existsSync(path.join(dir, 'dump.json'))) {
        clearInterval(waitDump);
        setTimeout(() => {
          if (!done) {
            done = true;
            resolve(false);
          }
        }, 1500);
      }
    }, 100);
  });
  check('пауза ждёт клавишу', problems, () => {
    if (exitedBeforeKey) {
      throw new Error('процесс завершился до клавиши — паузы нет');
    }
    if (!explorerOut.includes('Press any key')) {
      throw new Error(`пауза не напечатана, вывод: ${explorerOut.slice(0, 200)}`);
    }
  });
  const explorerRc = await new Promise(resolve => {
    explorer.stdin.write('x\n');
    explorer.on('exit', code => resolve(code));
  });
  check('код после клавиши', problems, () => {
    if (explorerRc !== 0) {
      throw new Error(`ожидался 0, получен ${explorerRc}`);
    }
  });

  // Консоль: признака Проводника нет — паузы нет, процесс выходит сам.
  const r = runBat(dir, 'install.bat', []);
  check('консоль — без паузы', problems, () => {
    if (r.status !== 0) {
      throw new Error(`ожидался 0, получен ${r.status}`);
    }
    if (`${r.stdout || ''}`.includes('Press any key')) {
      throw new Error('пауза есть при запуске строкой консоли');
    }
  });
  return problems;
}

function caseBootstrapFail() {
  const problems = [];
  const dir = makeCaseDir('bootstrap-fail');
  // Bootstrap должен сработать: node\ в этом случае быть не должно.
  fs.rmSync(path.join(dir, 'node'), { recursive: true, force: true });
  // Нет node\, зеркало недоступно: curl падает быстро, без сети.
  const r = runBat(dir, 'install.bat', ['/y'], {
    env: { MONITOR_NODE_MIRROR: 'http://127.0.0.1:9/' }
  });
  check('код 1', problems, () => {
    if (r.status !== 1) {
      throw new Error(`ожидался 1, получен ${r.status}: ${r.stdout || ''}${r.stderr || ''}`);
    }
  });
  check('читаемая причина', problems, () => {
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (!out.includes('Failed to download SHASUMS256.txt')) {
      throw new Error(`причина не найдена, вывод: ${out.slice(0, 200)}`);
    }
  });
  return problems;
}

// --- Главная ---------------------------------------------------------------

async function main() {
  const cases = [
    ['ascii', caseAscii()],
    ['pass-through', casePassThrough()],
    ['no-console', caseNoConsole()],
    ['explorer-pause', await caseExplorerPause()],
    ['exit-codes', await caseExitCodes()],
    ['bootstrap-fail', caseBootstrapFail()]
  ];
  let failed = 0;
  for (const [name, problems] of cases) {
    if (problems.length === 0) {
      console.log(`[install-bat] ${name}: OK`);
    } else {
      failed += 1;
      console.log(`[install-bat] ${name}: FAIL`);
      for (const p of problems) {
        console.log(`[install-bat]   - ${p}`);
      }
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(`[install-bat] сбой обвязки: ${e.message}`);
  process.exit(2);
});
