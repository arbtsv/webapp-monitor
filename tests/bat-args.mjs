/**
 * Обвязка shim-случаев `monitor.bat`. Bat — только кодировка консоли, локальный Node
 * в PATH, делегирование `scripts\monitor.mjs %*` и пауза при запуске из Проводника; разбора
 * аргументов в bat нет — вся строка уходит оркестратору. Здесь контроль этих трёх граней.
 *
 * Каждый случай — свежая копия каталога с настоящим `monitor.bat` и заглушкой
 * `scripts\monitor.mjs` вместо оркестратора: заглушка фиксирует argv и среду в dump.json
 * (путь — через BAT_ARGS_DUMP в среде запуска). node_modules не нужен.
 *
 * Случаи:
 *   1. `chcp` — консоль копии в UTF-8 (65001): заглушка читает кодовую страницу консоли.
 *   2. `pass-through` — `monitor.bat env.json "MONITOR_TARGET=a,b"`: argv заглушки ровно
 *      [env.json, MONITOR_TARGET=a,b] — кавычки cmd снял, значение с запятой доехало одним
 *      токеном.
 *   3. `explorer-pause` — запуск строкой Проводника (хвостовой пробел): после заглушки
 *      процесс ждёт клавишу; ответ по stdin разблокирует, код 0. Запуск строкой консоли
 *      (без признака Проводника) — паузы нет, процесс выходит сам, stdin не нужен.
 *
 * Запуск: `npm run test:bat` или `node ./tests/bat-args.mjs` из каталога бандла.
 * Коды: 0 — все случаи OK; 1 — хотя бы один FAIL; 2 — сбой самой обвязки (причина —
 * строкой `[bat-args] …`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

if (process.platform !== 'win32') {
  console.error('[bat-args] доступно только на win32 (monitor.bat — cmd-скрипт)');
  process.exit(2);
}

const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES_ROOT = path.join(BUNDLE_ROOT, 'artifacts', '_dev', 'bat-args-shim');
const BAT_PATH = path.join(BUNDLE_ROOT, 'monitor.bat');

/** Строка вида Проводника: вся командная строка в кавычках и пробел в конце. */
function explorerLine(batPath) {
  return '"' + `"${batPath}"` + ' "';
}

/** Свежая копия каталога случая: настоящий monitor.bat и заглушка оркестратора. */
function makeCaseDir(name) {
  const dir = path.join(CASES_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(BAT_PATH, path.join(dir, 'monitor.bat'));
  fs.writeFileSync(
    path.join(dir, 'scripts', 'monitor.mjs'),
    [
      '// Заглушка оркестратора: фиксирует argv и среду для обвязки bat-args.',
      "import * as fs from 'fs';",
      "import { spawnSync } from 'child_process';",
      'const dump = process.env.BAT_ARGS_DUMP;',
      "const cp = spawnSync('cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'utf8' });",
      'fs.writeFileSync(',
      '  dump,',
      '  JSON.stringify({',
      '    argv: process.argv.slice(2),',
      '    monTarget: process.env.MONITOR_TARGET || null,',
      "    codepage: (cp.stdout || '').trim(),",
      '  })',
      ');',
      ''
    ].join('\n'),
    'utf-8'
  );
  return dir;
}

/** Среда случая: без MONITOR_* оболочки, с путём dump. */
function caseEnv(dir) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('MONITOR_')) {
      env[name] = value;
    }
  }
  env.BAT_ARGS_DUMP = path.join(dir, 'dump.json');
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
    throw new Error('dump.json не создан — заглушка оркестратора не вызвана');
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

async function caseChcp() {
  const problems = [];
  const dir = makeCaseDir('chcp');
  const r = spawnSync('cmd.exe', ['/d', '/c', `"${path.join(dir, 'monitor.bat')}"`], {
    cwd: dir,
    env: caseEnv(dir),
    encoding: 'utf8',
    windowsVerbatimArguments: true
  });
  check('код', problems, () => {
    if (r.status !== 0) {
      throw new Error(`ожидался 0, получен ${r.status}: ${r.stderr || ''}`);
    }
  });
  check('кодовая страница', problems, () => {
    const dump = readDump(dir);
    if (!dump.codepage.includes('65001')) {
      throw new Error(`консоль не в UTF-8: chcp отвечает «${dump.codepage}»`);
    }
  });
  return problems;
}

async function casePassThrough() {
  const problems = [];
  const dir = makeCaseDir('pass-through');
  // Вся строка — в кавычках, каждый аргумент — в своих: иначе cmd /c неверно снимет
  // внешние кавычки (та же сборка строки, что в fake-cabinet.mjs).
  const line =
    '"' + [`"${path.join(dir, 'monitor.bat')}"`, '"env.json"', '"MONITOR_TARGET=srv1,srv2"'].join(' ') + '"';
  const r = spawnSync('cmd.exe', ['/d', '/c', line], {
    cwd: dir,
    env: caseEnv(dir),
    encoding: 'utf8',
    windowsVerbatimArguments: true
  });
  check('код', problems, () => {
    if (r.status !== 0) {
      throw new Error(`ожидался 0, получен ${r.status}: ${r.stderr || ''}`);
    }
  });
  check('argv', problems, () => {
    const dump = readDump(dir);
    const expected = ['env.json', 'MONITOR_TARGET=srv1,srv2'];
    if (JSON.stringify(dump.argv) !== JSON.stringify(expected)) {
      throw new Error(`argv ${JSON.stringify(dump.argv)} != ${JSON.stringify(expected)}`);
    }
    if (dump.monTarget !== null) {
      throw new Error(`MONITOR_TARGET доехал в среду мимо оркестратора: ${dump.monTarget}`);
    }
  });
  return problems;
}

async function caseExplorerPause() {
  const problems = [];
  const dir = makeCaseDir('explorer-pause');
  const batPath = path.join(dir, 'monitor.bat');
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
      // dump появился — заглушка отработала; даём паузе шанс завершиться и проверяем живучесть.
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
    setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, 15_000);
  });
  check('пауза из Проводника', problems, () => {
    if (exitedBeforeKey) {
      throw new Error('процесс вышел до клавиши — паузы из Проводника нет');
    }
    if (!/Press any key/i.test(explorerOut)) {
      throw new Error('в выводе нет приглашения «Press any key»');
    }
  });
  const explorerCode = await new Promise(resolve => {
    explorer.stdin.write('\r\n');
    explorer.on('exit', code => resolve(code));
    setTimeout(() => resolve(null), 10_000);
  });
  check('код после клавиши', problems, () => {
    if (explorerCode !== 0) {
      throw new Error(`ожидался 0 после клавиши, получен ${explorerCode}`);
    }
  });

  // Консоль: пробела в конце нет — паузы нет, процесс выходит сам.
  fs.rmSync(path.join(dir, 'dump.json'), { force: true });
  const consoleRun = spawnSync('cmd.exe', ['/d', '/c', `"${batPath}"`], {
    cwd: dir,
    env,
    encoding: 'utf8',
    windowsVerbatimArguments: true
  });
  check('без паузы из консоли', problems, () => {
    if (consoleRun.status !== 0) {
      throw new Error(`ожидался 0, получен ${consoleRun.status}`);
    }
    if (/Press any key/i.test(consoleRun.stdout || '')) {
      throw new Error('пауза есть при запуске из консоли');
    }
  });
  return problems;
}

const CASES = [
  ['chcp', caseChcp],
  ['pass-through', casePassThrough],
  ['explorer-pause', caseExplorerPause]
];

let failed = false;
for (const [name, run] of CASES) {
  const problems = await run();
  if (problems.length === 0) {
    console.log(`[bat-args] ${name}: OK`);
  } else {
    failed = true;
    for (const p of problems) {
      console.error(`[bat-args] ${name}: FAIL (${p})`);
    }
  }
}
process.exit(failed ? 1 : 0);
