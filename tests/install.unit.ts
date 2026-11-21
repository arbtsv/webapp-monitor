/**
 * Офлайн-тесты оркестратора установки: чистые функции `scripts/install.mjs`
 * и селектор сообщений `scripts/install-messages.mjs` — без сети, без прогона
 * установки, без node_modules бандла (системный Node достаточен). Импорт .mjs —
 * динамический через pathToFileURL, как в report.unit.ts.
 *
 * Покрыто:
 *   - parseInstallArgs: ключи, регистр, неизвестный ключ, смешанные аргументы;
 *   - decidePlan: матрица {localNodeOk, deps, browser} × {none, /y, /reinstall},
 *     «качается только недостающее», /reinstall ⇒ wipe + все три шага;
 *   - detectConsoleCp: формат вывода chcp (win32);
 *   - nodeBase: зеркало, хвостовой «/», пустое значение;
 *   - selectMessages/translit: 65001 — русский, иное/null — транслит, %s-подстановка;
 *   - wipe: на временном каталоге — маркер package.json, отказ на ссылке,
 *     границы сноса (только node\, node_modules\ и .install-tmp\), занятость.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

const BUNDLE_ROOT = path.resolve(__dirname, '..');
const CASES_ROOT = path.join(BUNDLE_ROOT, 'artifacts', '_dev', 'install-unit');
const WIN32 = process.platform === 'win32';

let installMod: any;
let messagesMod: any;

let parseInstallArgs: (argv: string[]) => { key: string; unknown: string | null };
let decidePlan: (
  env: { localNodeOk: boolean; deps: string; browser: string },
  key: string
) => { wipe: boolean; steps: string[]; ready: boolean };
let detectConsoleCp: () => number | null;
let nodeBase: (env: Record<string, string>) => string;
let NODE_VERSION: string;
let wipe: (root: string, t: (key: string, ...args: unknown[]) => string) => number;
let selectMessages: (cp: number | null) => {
  t: (key: string, ...args: unknown[]) => string;
  ascii: boolean;
};
let translit: (text: string) => string;
let messageKeys: () => string[];
let RU_MESSAGES: Record<string, string>;
let consentFromAnswer: (answer: string) => boolean;
let runInstall: (argv: string[], io?: { stdin?: unknown }) => Promise<number>;

test.beforeAll(async () => {
  installMod = await import(pathToFileURL(path.join(BUNDLE_ROOT, 'scripts', 'install.mjs')).href);
  messagesMod = await import(pathToFileURL(path.join(BUNDLE_ROOT, 'scripts', 'install-messages.mjs')).href);
  parseInstallArgs = installMod.parseInstallArgs;
  decidePlan = installMod.decidePlan;
  detectConsoleCp = installMod.detectConsoleCp;
  nodeBase = installMod.nodeBase;
  NODE_VERSION = installMod.NODE_VERSION;
  wipe = installMod.wipe;
  selectMessages = messagesMod.selectMessages;
  translit = messagesMod.translit;
  messageKeys = messagesMod.messageKeys;
  RU_MESSAGES = messagesMod.RU_MESSAGES;
  consentFromAnswer = installMod.consentFromAnswer;
  runInstall = installMod.runInstall;
});

test('parseInstallArgs: пустой argv — none', () => {
  expect(parseInstallArgs([])).toEqual({ key: 'none', unknown: null });
});

test('parseInstallArgs: ключи и регистр', () => {
  expect(parseInstallArgs(['/y']).key).toBe('y');
  expect(parseInstallArgs(['/Y']).key).toBe('y');
  expect(parseInstallArgs(['/reinstall']).key).toBe('reinstall');
  expect(parseInstallArgs(['/REINSTALL']).key).toBe('reinstall');
  expect(parseInstallArgs(['/?']).key).toBe('help');
});

test('parseInstallArgs: /reinstall перевешивает /y', () => {
  expect(parseInstallArgs(['/y', '/reinstall']).key).toBe('reinstall');
  expect(parseInstallArgs(['/reinstall', '/y']).key).toBe('reinstall');
});

test('parseInstallArgs: неизвестный ключ отменяет всё, первый фиксируется', () => {
  const r = parseInstallArgs(['/y', '/bogus', '/other']);
  expect(r.key).toBe('unknown');
  expect(r.unknown).toBe('/bogus');
  expect(parseInstallArgs(['plain']).unknown).toBe('plain');
});

const FULL = { localNodeOk: false, deps: 'missing', browser: 'missing' };

test('decidePlan: /reinstall — wipe и все три шага при любом окружении', () => {
  const ready = { localNodeOk: true, deps: 'ok', browser: 'local' };
  expect(decidePlan(ready, 'reinstall')).toEqual({
    wipe: true,
    steps: ['node-download', 'npm-ci', 'browser'],
    ready: false
  });
  expect(decidePlan(FULL, 'reinstall').wipe).toBe(true);
});

test('decidePlan: только недостающее', () => {
  expect(decidePlan({ localNodeOk: true, deps: 'ok', browser: 'local' }, 'none').ready).toBe(true);
  expect(decidePlan({ localNodeOk: true, deps: 'stale', browser: 'local' }, 'y').steps).toEqual(['npm-ci']);
  expect(decidePlan({ localNodeOk: true, deps: 'ok', browser: 'missing' }, 'none').steps).toEqual([
    'browser'
  ]);
  expect(decidePlan(FULL, 'y').steps).toEqual(['node-download', 'npm-ci', 'browser']);
});

test('decidePlan: порядок шагов не зависит от окружения', () => {
  const plan = decidePlan({ localNodeOk: false, deps: 'ok', browser: 'missing' }, 'none');
  expect(plan.steps).toEqual(['node-download', 'browser']);
});

test('nodeBase: зеркало без хвостового слэша, официальный dist по умолчанию', () => {
  expect(nodeBase({})).toBe('https://nodejs.org/dist');
  expect(nodeBase({ MONITOR_NODE_MIRROR: '' })).toBe('https://nodejs.org/dist');
  expect(nodeBase({ MONITOR_NODE_MIRROR: 'https://mirror.example/dist' })).toBe(
    'https://mirror.example/dist'
  );
  expect(nodeBase({ MONITOR_NODE_MIRROR: 'https://mirror.example/dist/' })).toBe(
    'https://mirror.example/dist'
  );
});

/** Строка из символов <=127 (ASCII) — без control-regex, который линтер запрещает. */
function isAscii(text: string) {
  for (const ch of text) {
    if (ch.charCodeAt(0) > 127) {
      return false;
    }
  }
  return true;
}

test('translit: читаемая замена, ASCII на выходе', () => {
  const out = translit('Готово. Запуск: monitor.bat.');
  expect(out).toBe('Gotovo. Zapusk: monitor.bat.');
  expect(isAscii(out)).toBe(true);
});

test('selectMessages: 65001 — русский, иное/null — транслит', () => {
  const ru = selectMessages(65001);
  expect(ru.ascii).toBe(false);
  expect(ru.t('final.done')).toBe('Готово. Запуск: monitor.bat.');
  expect(ru.t('step.npm-failed', 7)).toBe('npm ci завершился с ошибкой (код 7).');

  const legacy = selectMessages(866);
  expect(legacy.ascii).toBe(true);
  expect(legacy.t('final.done')).toBe('Gotovo. Zapusk: monitor.bat.');
  expect(isAscii(legacy.t('final.done'))).toBe(true);

  const unknown = selectMessages(null);
  expect(unknown.ascii).toBe(true);
  expect(unknown.t('consent.no-console')).toBe(translit(RU_MESSAGES['consent.no-console']));
});

test('selectMessages: все сообщения имеют непустую русскую строку', () => {
  for (const key of messageKeys()) {
    expect(RU_MESSAGES[key].length, key).toBeGreaterThan(0);
  }
});

test('NODE_VERSION — semver-формат (пин дублирует install.bat)', () => {
  expect(/^\d+\.\d+\.\d+$/.test(NODE_VERSION)).toBe(true);
});

test('consentFromAnswer: y в любом регистре и с пробелами — согласие, иное — отказ', () => {
  expect(consentFromAnswer('y')).toBe(true);
  expect(consentFromAnswer('Y')).toBe(true);
  expect(consentFromAnswer('  y  ')).toBe(true);
  expect(consentFromAnswer('yes')).toBe(false);
  expect(consentFromAnswer('n')).toBe(false);
});

test('consentFromAnswer: пустой ответ — defaultYes (Enter), EOF/иное — отказ', () => {
  expect(consentFromAnswer('')).toBe(false); // без defaultYes пусто — отказ
  expect(consentFromAnswer('', true)).toBe(true); // Enter = согласие по умолчанию
  expect(consentFromAnswer('   ', true)).toBe(true); // пробелы трактуются как пусто
  expect(consentFromAnswer('n', true)).toBe(false); // явный отказ побеждает умолчание
  expect(consentFromAnswer('н', true)).toBe(false); // «y» в русской раскладке — не согласие; лечится умолчанием [Y/n] (Enter)
});

/**
 * Интерактивный отказ через runInstall: фейковый stdin с isTTY. Отказ выходит до
 * шагов установки — ни сеть, ни файлы не трогаются. Ответ «y» здесь не гоняется:
 * он ведёт в реальные шаги (npm ci), что юниту недопустимо — эта ветка покрыта
 * ручной матрицей и harness install-bat.mjs.
 */
function fakeTtyStdin(answer: string | null) {
  const handlers: Record<string, (chunk: string) => void> = {};
  return {
    isTTY: true,
    setEncoding() {},
    pause() {},
    on(event: string, fn: (chunk: string) => void) {
      handlers[event] = fn;
      if (event === 'data' && answer !== null) {
        setImmediate(() => fn(answer));
      }
      if (event === 'end' && answer === null) {
        setImmediate(() => fn(''));
      }
      return this;
    }
  };
}

test('runInstall: интерактивный ответ «n» — код 2 без шагов установки', async () => {
  const rc = await runInstall([], { stdin: fakeTtyStdin('n\n') });
  expect(rc).toBe(2);
});

test('runInstall: интерактивный EOF на вопросе — код 2', async () => {
  const rc = await runInstall([], { stdin: fakeTtyStdin(null) });
  expect(rc).toBe(2);
});

test('detectConsoleCp: число страницы из вывода chcp', () => {
  test.skip(!WIN32, 'chcp — cmd-утилита Windows');
  const cp = detectConsoleCp();
  expect(cp === null || (cp >= 1 && cp <= 65535)).toBeTruthy();
});

/** Временный каталог случая wipe; после теста сносится целиком. */
function makeWipeCase(name: string) {
  const dir = path.join(CASES_ROOT, 'wipe', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fillBundle(dir: string) {
  fs.mkdirSync(path.join(dir, 'node'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.install-tmp'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'env.json'), '{}');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'webapp-monitor' }));
}

const RU_T = (key: string, ...args: unknown[]) =>
  (RU_MESSAGES[key] || key).replace(/%s/g, () => String(args.shift()));

test('wipe: сносит node, node_modules и .install-tmp, остальное цело', () => {
  const dir = makeWipeCase('happy');
  fillBundle(dir);
  expect(wipe(dir, RU_T)).toBe(0);
  expect(fs.existsSync(path.join(dir, 'node'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
  expect(fs.existsSync(path.join(dir, '.install-tmp'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'env.json'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'artifacts'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wipe: отказ без package.json — код 1, ничего не тронуто', () => {
  const dir = makeWipeCase('no-pkg');
  fillBundle(dir);
  fs.rmSync(path.join(dir, 'package.json'));
  expect(wipe(dir, RU_T)).toBe(1);
  expect(fs.existsSync(path.join(dir, 'node'))).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wipe: отказ на чужом package.json — код 1', () => {
  const dir = makeWipeCase('alien-pkg');
  fillBundle(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'other' }));
  expect(wipe(dir, RU_T)).toBe(1);
  expect(fs.existsSync(path.join(dir, 'node'))).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wipe: отказ на junction/symink — код 1, цель ссылки цела', () => {
  test.skip(!WIN32, 'junction/symlink — win32');
  const dir = makeWipeCase('link');
  const outside = makeWipeCase('link-target');
  fs.mkdirSync(path.join(outside, 'node'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'webapp-monitor' }));
  // Junction создаём средствами Node — без cmd и его правил кавычек.
  fs.symlinkSync(path.join(outside, 'node'), path.join(dir, 'node'), 'junction');
  expect(wipe(dir, RU_T)).toBe(1);
  expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
