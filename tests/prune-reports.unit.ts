/**
 * Офлайн-тест `scripts/prune-reports.mjs`: удаляются только обычные файлы `report_<...>.zip`
 * старше заданного срока; `report.zip`, каталог с похожим именем и свежие архивы целы; отказ и
 * неверный ввод ничего не удаляют. Фикстуры — в свежем `artifacts/_dev/prune-unit/<случай>/`.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const BUNDLE_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(BUNDLE_ROOT, 'scripts', 'prune-reports.mjs');
const CASES_ROOT = path.join(BUNDLE_ROOT, 'artifacts', '_dev', 'prune-unit');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Каталог артефактов случая: старые (40 и 20 дней), свежий, `report.zip` и каталог `report_dir.zip`. */
function fixture(name: string): string {
  const dir = path.join(CASES_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const age = (file: string, days: number) => {
    const p = path.join(dir, file);
    fs.writeFileSync(p, 'x');
    const t = new Date(Date.now() - days * DAY_MS);
    fs.utimesSync(p, t, t);
  };
  age('report_old40.zip', 40);
  age('report_old20.zip', 20);
  age('report_new.zip', 0);
  age('report.zip', 100);
  fs.mkdirSync(path.join(dir, 'report_dir.zip'));
  return dir;
}

function run(dir: string, args: string[], input = '') {
  const r = spawnSync('node', [SCRIPT, ...args], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, MONITOR_ARTIFACTS: dir }
  });
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}`,
    left: fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
  };
}

test('--days 30 --yes: удаляет только архив старше срока', () => {
  const r = run(fixture('days-yes'), ['--days', '30', '--yes']);
  expect(r.code).toBe(0);
  expect(r.left).toEqual(['report.zip', 'report_dir.zip', 'report_new.zip', 'report_old20.zip']);
});

test('вопросы по очереди из конвейера: срок и подтверждение', () => {
  const r = run(fixture('prompt-yes'), [], '10\ny\n');
  expect(r.code).toBe(0);
  expect(r.left).toEqual(['report.zip', 'report_dir.zip', 'report_new.zip']);
});

test('отказ и пустой срок ничего не удаляют', () => {
  const all = ['report.zip', 'report_dir.zip', 'report_new.zip', 'report_old20.zip', 'report_old40.zip'];
  expect(run(fixture('prompt-no'), [], '10\nn\n').left).toEqual(all);
  expect(run(fixture('prompt-empty'), [], '\n').left).toEqual(all);
  expect(run(fixture('prompt-eof'), [], '').left).toEqual(all);
});

test('неверный срок: код 2, ничего не удалено', () => {
  for (const [name, args, input] of [
    ['bad-input', [], 'abc\n'],
    ['bad-arg', ['--days', '-5', '--yes'], ''],
    ['bad-arg-empty', ['--days'], '']
  ] as const) {
    const r = run(fixture(name), [...args], input);
    expect(r.code, name).toBe(2);
    expect(r.left, name).toHaveLength(5);
  }
});

test('нечего удалять: код 0 и сообщение', () => {
  const r = run(fixture('nothing'), ['--days', '365', '--yes']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('удалять нечего');
  expect(r.left).toHaveLength(5);
});

test('--days=N и ответ «д» на подтверждение', () => {
  expect(run(fixture('eq-form'), ['--days=30', '--yes']).left).toEqual([
    'report.zip',
    'report_dir.zip',
    'report_new.zip',
    'report_old20.zip'
  ]);
  expect(run(fixture('ru-yes'), ['--days', '30'], 'д\n').left).toEqual([
    'report.zip',
    'report_dir.zip',
    'report_new.zip',
    'report_old20.zip'
  ]);
});

test('--yes без --days: код 2, подтверждение не пропускается', () => {
  const r = run(fixture('yes-only'), ['--yes'], '10\n');
  expect(r.code).toBe(2);
  expect(r.left).toHaveLength(5);
});

test('архив последнего прогона не удаляется даже при --days 0', () => {
  const dir = fixture('last-run');
  fs.writeFileSync(path.join(dir, 'last-run-id.txt'), 'old40\n');
  const r = run(dir, ['--days', '0', '--yes']);
  expect(r.code).toBe(0);
  expect(r.left).toEqual(['last-run-id.txt', 'report.zip', 'report_dir.zip', 'report_old40.zip']);
});

test('защищённый архив остаётся в счёте и называется; без last-run-id.txt — предупреждение', () => {
  const dir = fixture('protected-msg');
  fs.writeFileSync(path.join(dir, 'last-run-id.txt'), 'old40\n');
  const r = run(dir, ['--days', '30', '--yes']);
  expect(r.out).toContain('защищён архив последнего прогона: report_old40.zip');
  expect(r.out).toContain('всего архивов: 3');
  expect(run(fixture('no-last-run'), ['--days', '30', '--yes']).out).toContain('не защищён');
});

test('--yes без --days: код 2 и при отсутствии каталога артефактов', () => {
  const r = run(path.join(CASES_ROOT, 'no-such-dir'), ['--yes']);
  expect(r.code).toBe(2);
});
