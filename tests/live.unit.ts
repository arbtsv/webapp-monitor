/**
 * Юнит-тесты тонкого консольного репортёра: чистые
 * функции из reporters/live.ts (подписи шагов, живая/итоговая строки, очистка ANSI,
 * символы исходов) и состояние репортёра (счётчики, живые строки, ветка `--list` в
 * playwright.config.ts). Репортёр в тестах — в plain-профиле: tty/ascii/color заданы
 * принудительно (детекты платформозависимы); доступ к приватному состоянию — через
 * двойной каст без `any`.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import LiveReporter, {
  stripAnsi,
  timePrefix,
  truncate,
  stepCaption,
  formatLiveLine,
  formatElapsed,
  verdictMark,
  firstErrorLine,
} from '../reporters/live';
import type { FullConfig, FullResult, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

test('stepCaption: часть до первого `:`', () => {
  expect(stepCaption('Страница входа: поле логина')).toBe('Страница входа');
  expect(stepCaption('Кабинет: дерево олимпиад: развернуть')).toBe('Кабинет');
});

test('stepCaption: без `:` — заголовок как есть', () => {
  expect(stepCaption('Страница входа')).toBe('Страница входа');
});

test('stepCaption: пустая до-часть — заголовок как есть', () => {
  expect(stepCaption(': только хвост')).toBe(': только хвост');
});

test('formatLiveLine: состав `{кадр} {N} {узел} › {сценарий} › {шаг} {SS.S}`, с левым отступом', () => {
  expect(formatLiveLine('⠋', 1, 'srv-prod', 8, 'кабинет олимпиад', 'Страница входа', '7.3', '›')).toBe(
    '  ⠋ 1 srv-prod › кабинет олимпиад › Страница входа 7.3'
  );
});

test('formatLiveLine: до первого шага шаг опускается, счётчик времени — нет', () => {
  expect(formatLiveLine('|', 2, 'srv-prod', 8, 'кабинет олимпиад', null, '7.3', '|')).toBe(
    '  | 2 srv-prod | кабинет олимпиад 7.3'
  );
});

test('formatLiveLine: выравнивание метки по labelWidth', () => {
  expect(formatLiveLine('x', 1, 'a', 5, 't', null, '0.0', '›')).toBe('  x 1 a     › t 0.0');
});

test('formatElapsed: секунды с десятой, ширина фиксирована до 100 с', () => {
  expect(formatElapsed(0)).toBe('0.0');
  expect(formatElapsed(7000)).toBe('7.0');
  expect(formatElapsed(7543)).toBe('7.5');
  expect(formatElapsed(65000)).toBe('65.0');
});

test('formatElapsed: отрицательное — 0.0; после 100 с ширина растёт разово', () => {
  expect(formatElapsed(-5)).toBe('0.0');
  expect(formatElapsed(100200)).toBe('100.2');
});

test('truncate: длинный текст обрезается, короткий — как есть', () => {
  expect(truncate('abcdef', 3)).toBe('abc');
  expect(truncate('ab', 3)).toBe('ab');
  expect(truncate('abc', 0)).toBe('');
});

test('verdictMark: исходы', () => {
  expect(verdictMark(false, 'passed', 'passed')).toEqual({ symbol: '✓', kind: 'ok', note: '' });
  expect(verdictMark(true, 'passed', 'passed')).toEqual({ symbol: 'ok', kind: 'ok', note: '' });
  expect(verdictMark(false, 'failed', 'passed')).toEqual({ symbol: '✘', kind: 'fail', note: '' });
  expect(verdictMark(true, 'failed', 'passed')).toEqual({ symbol: 'x', kind: 'fail', note: '' });
  expect(verdictMark(false, 'timedOut', 'passed')).toEqual({ symbol: '✘', kind: 'fail', note: ' (таймаут теста)' });
  expect(verdictMark(false, 'interrupted', 'passed')).toEqual({ symbol: '✘', kind: 'fail', note: ' (прерван)' });
  expect(verdictMark(false, 'skipped', 'passed')).toEqual({ symbol: '-', kind: 'skipped', note: '' });
  // expectedStatus !== 'passed' — не-ok исход даже при совпадении статуса.
  expect(verdictMark(false, 'failed', 'failed').kind).toBe('fail');
});

test('firstErrorLine: ANSI очищается, берётся первая непустая строка', () => {
  const result = { error: { message: '\u001B[31mTimeout\u001B[0m\n\n  locator: x' }, errors: [] } as unknown as TestResult;
  expect(firstErrorLine(result)).toBe('Timeout');
});

test('firstErrorLine: длинная строка обрезается до ~200 символов', () => {
  const result = { error: { message: 'x'.repeat(300) }, errors: [] } as unknown as TestResult;
  const line = firstErrorLine(result);
  expect(line ? line.length : 0).toBeLessThanOrEqual(201);
  expect(line ? line.endsWith('…') : false).toBe(true);
});

test('firstErrorLine: в ASCII-профиле многоточие ASCII', () => {
  const result = { error: { message: 'x'.repeat(300) }, errors: [] } as unknown as TestResult;
  expect(firstErrorLine(result, true)).toBe(`${'x'.repeat(200)}...`);
});

test('firstErrorLine: нет ошибки — null; fallback на errors[] и value', () => {
  expect(firstErrorLine({ errors: [] } as unknown as TestResult)).toBeNull();
  expect(firstErrorLine({ errors: [{ message: 'из массива' }] } as unknown as TestResult)).toBe('из массива');
  expect(firstErrorLine({ error: { value: 42 }, errors: [] } as unknown as TestResult)).toBe('42');
});

test('stripAnsi: SGR-последовательности удаляются', () => {
  expect(stripAnsi('\u001B[1;91mкрасный\u001B[0m текст')).toBe('красный текст');
});

test('timePrefix: формат HH:MM:SS', () => {
  expect(timePrefix()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
});

// --- состояние репортёра, plain-профиль (tty/ascii/color заданы принудительно) ---

/** Приватное состояние LiveReporter — для тестов (поля в классе `readonly`/private). */
interface ReporterState {
  tty: boolean;
  ascii: boolean;
  color: boolean;
  sep: string;
  timer: ReturnType<typeof setInterval> | null;
  nextOrdinal: number;
  okCount: number;
  xCount: number;
  skippedCount: number;
  liveLinesDrawn: number;
  pendingPermanent: string[];
  resizePending: boolean;
  lastResizeAt: number;
  lastFrameLengths: number[];
  onResize: () => void;
  redraw: () => void;
  active: Map<TestResult, { ordinal: number; label: string; title: string; step: string | null; startedAt: number }>;
}

function makeReporter(): LiveReporter {
  const reporter = new LiveReporter();
  const state = reporter as unknown as ReporterState;
  state.tty = false; // plain: лог start/end, нет ANSI/`\r`
  state.ascii = false; // юникод-символы ✓/✘ и разделитель `›`
  state.sep = '›';
  state.color = false;
  return reporter;
}

function stateOf(reporter: LiveReporter): ReporterState {
  return reporter as unknown as ReporterState;
}

function makeTest(overrides: Partial<TestCase> = {}): TestCase {
  return {
    title: 'кабинет олимпиад',
    expectedStatus: 'passed',
    parent: { project: () => ({ name: 'srv-prod' }) },
    titlePath: () => ['', 'srv-prod', 'кабинет олимпиад'],
    ...overrides,
  } as unknown as TestCase;
}

function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  return { status: 'passed', duration: 1234, errors: [], ...overrides } as unknown as TestResult;
}

function makeStep(category: string, title: string): TestStep {
  return { category, title } as unknown as TestStep;
}

/** Перехват process.stdout.write на время fn; возвращает всё напечатанное. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const stdout = process.stdout as unknown as { write(chunk: unknown): boolean };
  const original = stdout.write;
  stdout.write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    stdout.write = original;
  }
  return chunks.join('');
}

test('onTestBegin: сквозной номер с 1, старт-строка без файла:строка:колонка', () => {
  const reporter = makeReporter();
  const out = captureStdout(() => {
    reporter.onTestBegin(makeTest(), makeResult());
    reporter.onTestBegin(
      makeTest({ title: 'второй', titlePath: () => ['', 'specs\\olymp.spec.ts:8:5', 'второй'] }),
      makeResult()
    );
  });
  expect(out).toContain('старт 1 srv-prod › кабинет олимпиад');
  expect(out).toContain('старт 2 srv-prod › второй');
  expect(out).not.toContain('olymp.spec.ts:8:5');
  // plain-профиль: ни одного байта ANSI и `\r`.
  expect(out).not.toContain('\u001B');
  expect(out).not.toContain('\r');
  expect(stateOf(reporter).nextOrdinal).toBe(3);
});

test('onStepBegin: только test.step; подпись сохраняется между шагами', () => {
  const reporter = makeReporter();
  const result = makeResult();
  reporter.onTestBegin(makeTest(), result);
  reporter.onStepBegin(makeTest(), result, makeStep('hook', 'beforeEach'));
  expect(stateOf(reporter).active.get(result) ? stateOf(reporter).active.get(result)!.step : null).toBeNull();
  reporter.onStepBegin(makeTest(), result, makeStep('test.step', 'Страница входа: поле'));
  expect(stateOf(reporter).active.get(result) ? stateOf(reporter).active.get(result)!.step : null).toBe('Страница входа');
  reporter.onStepBegin(makeTest(), result, makeStep('test.step', 'Кабинет'));
  expect(stateOf(reporter).active.get(result) ? stateOf(reporter).active.get(result)!.step : null).toBe('Кабинет');
});

test('onTestEnd: запись удаляется из active; итоговая строка по контракту', () => {
  const reporter = makeReporter();
  const a = makeResult();
  const b = makeResult({ status: 'failed', duration: 2500, error: { message: 'неверный пароль' } });
  const c = makeResult({ status: 'skipped' });
  const out = captureStdout(() => {
    reporter.onTestBegin(makeTest(), a);
    reporter.onTestBegin(makeTest({ title: 'второй' }), b);
    reporter.onTestBegin(makeTest(), c);
    reporter.onTestEnd(makeTest(), a);
    expect(stateOf(reporter).active.size).toBe(2);
    reporter.onTestEnd(makeTest({ title: 'второй' }), b);
    reporter.onTestEnd(makeTest(), c);
  });
  expect(stateOf(reporter).active.size).toBe(0);
  expect(out).toContain('✓ 1 srv-prod › кабинет олимпиад (1.2с)');
  expect(out).toContain('✘ 2 srv-prod › второй (2.5с)');
  expect(out).toContain('    неверный пароль');
  expect(out).toContain('- 3 srv-prod › кабинет олимпиад'); // пропуск — без длительности
  expect(out).not.toContain('\u001B');
  expect(out).not.toContain('\r');
});

test('RunStats: passed/failed/skipped/timedOut и сводка onEnd', () => {
  const reporter = makeReporter();
  captureStdout(() => {
    reporter.onTestEnd(makeTest(), makeResult());
    reporter.onTestEnd(makeTest(), makeResult({ status: 'failed', error: { message: 'x' } }));
    reporter.onTestEnd(makeTest(), makeResult({ status: 'skipped' }));
    reporter.onTestEnd(makeTest(), makeResult({ status: 'timedOut', error: { message: 'x' } }));
  });
  expect(stateOf(reporter).okCount).toBe(1);
  expect(stateOf(reporter).xCount).toBe(2);
  expect(stateOf(reporter).skippedCount).toBe(1);
  const done = { status: 'passed', duration: 5000 } as unknown as FullResult;
  const out = captureStdout(() => reporter.onEnd(done));
  expect(out).toContain('Готово за 5.0с: 1 ok, 2 x, 1 пропущено');
  const interrupted = { status: 'interrupted', duration: 100 } as unknown as FullResult;
  expect(captureStdout(() => reporter.onEnd(interrupted))).toContain(' (прервано)');
});

test('onError: стек глобальной ошибки без ANSI, построчно', () => {
  const reporter = makeReporter();
  const out = captureStdout(() => reporter.onError({ stack: 'Ошибка: бум\n  at x (y:1:1)' }));
  expect(out).toContain('ОШИБКА:');
  expect(out).toContain('Ошибка: бум');
  expect(out).toContain('  at x (y:1:1)');
});

test('onStdOut/onStdErr в plain-профиле — прямой проброс без ANSI', () => {
  const reporter = makeReporter();
  const out = captureStdout(() => reporter.onStdOut('warn: порог\n'));
  expect(out).toBe('warn: порог\n');
});

test('plain-профиль: счётчика времени в логе нет — только якоря HH:MM:SS на старте/финале', () => {
  const reporter = makeReporter();
  const out = captureStdout(() => {
    reporter.onTestBegin(makeTest(), makeResult());
    reporter.onTestEnd(makeTest(), makeResult());
  });
  expect(out).toContain('старт 1 srv-prod › кабинет олимпиад');
  for (const line of out.split('\n')) {
    expect(/\d+\.\d$/.test(line)).toBe(false); // `SS.S` в конце строки — признак живой строки
  }
});

test('onEnd: таймер останавливается первым делом', () => {
  const reporter = makeReporter();
  stateOf(reporter).timer = setInterval(() => undefined, 1000);
  const done = { status: 'passed', duration: 0 } as unknown as FullResult;
  reporter.onEnd(done);
  expect(stateOf(reporter).timer).toBeNull();
});

// --- TTY-профиль: рамка блока итогов, обрезка постоянных строк, ресайз ---

function makeTtyReporter(): LiveReporter {
  const reporter = new LiveReporter();
  const state = stateOf(reporter);
  state.tty = true; // живой вывод; columns/rows задаются через withConsoleSize
  state.ascii = false;
  state.sep = '›';
  state.color = false;
  return reporter;
}

/** columns/rows у не-TTY stdout — обычные writable-свойства; восстанавливаются после fn. */
function withConsoleSize(columns: number, rows: number, fn: () => string): string {
  const stdout = process.stdout as unknown as { columns?: number; rows?: number };
  const prev = { columns: stdout.columns, rows: stdout.rows };
  stdout.columns = columns;
  stdout.rows = rows;
  try {
    return fn();
  } finally {
    stdout.columns = prev.columns;
    stdout.rows = prev.rows;
  }
}

test('TTY: пустая строка перед первой живой и перед сводкой (рамка блока)', () => {
  const reporter = makeTtyReporter();
  const out = withConsoleSize(120, 40, () =>
    captureStdout(() => {
      const first = makeResult();
      const second = makeResult();
      reporter.onTestBegin(makeTest(), first);
      reporter.onTestBegin(makeTest({ title: 'второй' }), second);
      reporter.onTestEnd(makeTest(), first);
      reporter.onTestEnd(makeTest({ title: 'второй' }), second);
      reporter.onEnd({ status: 'passed', duration: 1000 } as unknown as FullResult);
    })
  );
  // Постоянные строки пишутся `\r\u001B[2K{текст}\n`; пустая рамка — `\r\u001B[2K\n`.
  // Живые строки между flush'ами перерисовываются — проверяем порядок, не смежность.
  // Отступ сверху ставится на первом onTestBegin: до первой итоговой ровно одна пустая строка.
  const pad = '\r\u001B[2K\n';
  const between = out.slice(out.indexOf('✓ 1 srv-prod'), out.indexOf('✓ 2 srv-prod'));
  expect(out.indexOf(pad)).toBeLessThan(out.indexOf('✓ 1 srv-prod')); // padding сверху живой области
  expect(out.slice(out.indexOf(pad) + pad.length, out.indexOf('✓ 1 srv-prod'))).not.toContain(pad); // без двойного отступа
  expect(between).toContain(pad); // разделитель между итоговыми строками
  expect(out.lastIndexOf(pad)).toBeLessThan(out.indexOf('Готово за')); // padding перед сводкой
});

test('TTY: живые и итоговые строки с двухсимвольным левым отступом', () => {
  const reporter = makeTtyReporter();
  const out = withConsoleSize(120, 40, () =>
    captureStdout(() => {
      const result = makeResult({ status: 'failed', duration: 2500, error: { message: 'неверный пароль' } });
      reporter.onTestBegin(makeTest(), result);
      reporter.onTestEnd(makeTest(), result);
    })
  );
  const text = stripAnsi(out).replace(/\r/g, '');
  expect(text).toContain('  ✘ 1 srv-prod › кабинет олимпиад (2.5с)');
  expect(text).toContain('      неверный пароль'); // отступ строки + прежние 4 пробела вложенности
});

test('plain-профиль: рамки блока нет — лог остаётся плотной лесенкой', () => {
  const reporter = makeReporter();
  const out = captureStdout(() => {
    const first = makeResult();
    const second = makeResult();
    reporter.onTestBegin(makeTest(), first);
    reporter.onTestBegin(makeTest(), second);
    reporter.onTestEnd(makeTest(), first);
    reporter.onTestEnd(makeTest(), second);
    reporter.onEnd({ status: 'passed', duration: 1000 } as unknown as FullResult);
  });
  expect(out).not.toContain('\n\n');
  expect(out).toMatch(/✓ 1 srv-prod › кабинет олимпиад \(1\.2с\)\n\d{2}:\d{2}:\d{2} ✓ 2 srv-prod/);
  expect(out).toContain('✓ 2 srv-prod › кабинет олимпиад (1.2с)\nГотово за 1.0с');
});

test('TTY: постоянные строки обрезаются по ширине консоли — переноса нет', () => {
  const reporter = makeTtyReporter();
  const out = withConsoleSize(60, 40, () =>
    captureStdout(() => {
      const result = makeResult({ duration: 5700 });
      reporter.onTestBegin(makeTest({ title: 'кабинет олимпиад школьников: вход и раздел второго тура' }), result);
      reporter.onTestEnd(makeTest({ title: 'кабинет олимпиад школьников: вход и раздел второго тура' }), result);
      reporter.onEnd({ status: 'passed', duration: 0 } as unknown as FullResult);
    })
  );
  // Flush пишет `\r\u001B[2K{text}\n`: `\r` остаётся в начале сегмента после сплита.
  for (const line of stripAnsi(out).split('\n').map(l => l.replace(/\r/g, ''))) {
    if (line.includes('кабинет')) { expect(line.length).toBeLessThanOrEqual(59); }
  }
});

test('TTY: resize во время драга замораживает redraw — мусорных строк нет', () => {
  const reporter = makeTtyReporter();
  const state = stateOf(reporter);
  state.liveLinesDrawn = 3;
  state.pendingPermanent = [];
  state.onResize(); // драг: событие есть, тишины нет
  expect(state.resizePending).toBe(true);
  expect(state.liveLinesDrawn).toBe(3); // сброса сразу нет — дебаунс
  const out = withConsoleSize(120, 40, () => captureStdout(() => state.redraw()));
  expect(out).toBe(''); // в reflow'ящийся буфер не рисуем
  expect(state.liveLinesDrawn).toBe(3);
  expect(state.pendingPermanent).not.toContain('');
});

test('TTY: после тишины resize стирает старую живую область и рисует новый кадр на её месте', () => {
  const reporter = makeTtyReporter();
  const state = stateOf(reporter);
  const result = makeResult();
  withConsoleSize(120, 40, () => captureStdout(() => reporter.onTestBegin(makeTest(), result)));
  const lineLen = state.lastFrameLengths[0]; // видимая длина нарисованной живой строки
  state.liveLinesDrawn = 3; // счётчик «уехал» после reflow — стирание не по нему
  state.onResize();
  state.lastResizeAt = Date.now() - 1000; // тишина выдержана
  const out = withConsoleSize(120, 40, () =>
    captureStdout(() => {
      state.redraw(); // стирание по пересчёту + новый кадр
      state.redraw(); // второй такт без новых событий: второго стирания нет
    })
  );
  expect(state.resizePending).toBe(false);
  expect(state.liveLinesDrawn).toBe(1); // одна живая строка заново
  const rows = Math.ceil(lineLen / 120);
  // Стирание первым действием; финальный подъём — курсор на ВЕРХ стёртой области, иначе кадр
  // встал бы на ряд ниже прежнего места и каждый ресайз добавлял бы пустую строку сверху.
  expect(out.startsWith(`\u001B[${rows}A` + '\r\u001B[2K\n'.repeat(rows) + `\u001B[${rows}A`)).toBe(true);
  expect(out).not.toContain('\u001B[3A'); // не по сломанному счётчику (3 ряда), а по пересчёту
  expect(out).toContain('srv-prod'); // новый кадр нарисован
});

test('TTY: сброс после ресайза пересчитывает ряды по новой ширине (перенос reflow)', () => {
  const reporter = makeTtyReporter();
  const state = stateOf(reporter);
  const result = makeResult();
  withConsoleSize(120, 40, () => captureStdout(() => reporter.onTestBegin(makeTest(), result)));
  const lineLen = state.lastFrameLengths[0];
  state.liveLinesDrawn = 1;
  state.onResize();
  state.lastResizeAt = Date.now() - 1000;
  const out = withConsoleSize(20, 40, () => captureStdout(() => state.redraw())); // окно стало уже
  const rows = Math.max(1, Math.ceil(lineLen / 20)); // строка занимает больше одного ряда
  expect(rows).toBeGreaterThan(1);
  expect(out.startsWith(`\u001B[${rows}A` + '\r\u001B[2K\n'.repeat(rows) + `\u001B[${rows}A`)).toBe(true);
});

test('TTY: resize до первой живой строки не пишет ничего', () => {
  const reporter = makeTtyReporter();
  const state = stateOf(reporter);
  state.liveLinesDrawn = 0;
  state.pendingPermanent = [];
  state.onResize();
  state.lastResizeAt = Date.now() - 1000;
  const out = withConsoleSize(120, 40, () => captureStdout(() => state.redraw()));
  expect(state.liveLinesDrawn).toBe(0);
  expect(out).toBe(''); // стирать нечего и рисовать нечего
});

test('TTY: onEnd с неотработавшим resize стирает область по пересчёту и печатает сводку', () => {
  const reporter = makeTtyReporter();
  const state = stateOf(reporter);
  state.liveLinesDrawn = 2; // сломанный счётчик, доверия к нему нет
  state.lastFrameLengths = [50, 30]; // свежий пересчёт: 2 ряда при ширине 120
  state.pendingPermanent = [];
  state.onResize(); // тишина не наступила, таймер onEnd остановит
  const out = withConsoleSize(120, 40, () =>
    captureStdout(() => reporter.onEnd({ status: 'passed', duration: 1000 } as unknown as FullResult))
  );
  expect(out.startsWith('\u001B[2A')).toBe(true); // стирание по длинам кадра, а не по счётчику
  expect(out).toContain('Готово за 1.0с');
});

test('TTY: счётчик атомарен по тесту — у каждой живой строки своё startedAt', () => {
  const reporter = makeTtyReporter();
  const state = stateOf(reporter);
  const first = makeResult();
  const second = makeResult();
  withConsoleSize(120, 40, () =>
    captureStdout(() => {
      reporter.onTestBegin(makeTest(), first);
      reporter.onTestBegin(makeTest({ title: 'второй' }), second);
    })
  );
  const firstEntry = state.active.get(first);
  const secondEntry = state.active.get(second);
  expect(firstEntry).toBeDefined();
  expect(secondEntry).toBeDefined();
  if (!firstEntry || !secondEntry) { return; }
  firstEntry.startedAt = Date.now() - 7300; // первому тесту — 7.3 с
  secondEntry.startedAt = Date.now() - 1200; // второму — 1.2 с
  const out = withConsoleSize(120, 40, () => captureStdout(() => state.redraw()));
  const text = stripAnsi(out);
  expect(text).toMatch(/srv-prod › кабинет олимпиад 7\.3/);
  expect(text).toMatch(/второй 1\.2/);
});

test('TTY: счётчик не зависит от наличия шага — до первого шага тоже рисуется', () => {
  const reporter = makeTtyReporter();
  const result = makeResult();
  const out = withConsoleSize(120, 40, () =>
    captureStdout(() => {
      reporter.onTestBegin(makeTest(), result);
      reporter.onStepBegin(makeTest(), result, makeStep('test.step', 'Страница входа: поле'));
      stateOf(reporter).redraw(); // onStepBegin кадр не перерисовывает — следующий такт таймера
    })
  );
  expect(stripAnsi(out)).toMatch(/кабинет олимпиад › Страница входа \d+\.\d/);
  // отдельный прогон без единого шага: хвост строки — всё равно счётчик
  const bare = makeTtyReporter();
  const bareOut = withConsoleSize(120, 40, () => captureStdout(() => bare.onTestBegin(makeTest(), makeResult())));
  expect(stripAnsi(bareOut)).toMatch(/srv-prod › кабинет олимпиад \d+\.\d/);
});

test('onBegin/onEnd: подписка resize ставится и снимается', () => {
  const reporter = makeTtyReporter();
  const baseline = process.stdout.listenerCount('resize');
  reporter.onBegin({} as unknown as FullConfig, { suites: [] } as unknown as Suite);
  expect(process.stdout.listenerCount('resize')).toBe(baseline + 1);
  reporter.onEnd({ status: 'passed', duration: 0 } as unknown as FullResult);
  expect(process.stdout.listenerCount('resize')).toBe(baseline);
});

test('playwright.config.ts: --list ветка остаётся встроенным `list`, live — только в не-list', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.ts'), 'utf8');
  expect(text).toContain("require.resolve('./reporters/live')");
  const branch = text.match(/isListMode\s*\?\s*([\s\S]*?)\s*:/);
  expect(branch).not.toBeNull();
  expect(branch ? branch[1] : '').toBe("'list'");
});
