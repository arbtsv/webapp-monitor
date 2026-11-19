/**
 * Тонкий консольный репортёр прогона вместо встроенного `list`: TTY — живая строка на тест
 * `{кадр} {N} {узел} › {сценарий} › {шаг} {SS.S}` + итоги со статусом/длительностью; не-TTY —
 * лог start/end без ANSI и `\r`; метрик нет; в `--list` не подключается (ветка в playwright.config.ts).
 */
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter';

// Встроенный list-reporter так определяет ненадёжный UTF-8: win32 без TERM_PROGRAM=vscode и WT_SESSION — символы ASCII.
const ASCII_TERMINAL = process.platform === 'win32' && process.env.TERM_PROGRAM !== 'vscode' && !process.env.WT_SESSION;

const ASCII_SPINNER = ['|', '/', '-', '\\'];
const BRAILLE_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const SGR_GREEN = '\u001B[32m';
const SGR_RED = '\u001B[31m';
// Тёмно-серый, а не faint (2): классическая консоль Windows (conhost) faint не рисует.
const SGR_DIM = '\u001B[90m';
const SGR_RESET = '\u001B[0m';

// Левый отступ строк прогона и итогов (TTY): строки не прижаты к краю окна.
const INDENT = '  ';

// Тишина после потока событий resize, мс: драг считается окончившимся. Таймер 100 мс —
// одновременно такт дебаунса: отдельный таймер не нужен.
const RESIZE_QUIET_MS = 200;

// eslint-disable-next-line no-control-regex -- ESC и есть искомый символ
const ANSI_REGEX = /([\u001B\u009B][[\]()#?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{0,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])))/g;

/** Очистка ANSI (как `stripAnsiEscapes` Playwright): чужой текст не должен управлять терминалом. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

/** Префикс времени не-TTY лога: `HH:MM:SS`. */
export function timePrefix(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

export function truncate(text: string, width: number): string {
  return text.length > width ? text.slice(0, Math.max(0, width)) : text;
}

/** Часть заголовка шага до первого `:` — подробность в живую строку не попадает. Без `:` — как есть. */
export function stepCaption(title: string): string {
  const idx = title.indexOf(':');
  if (idx === -1) {
    return title;
  }
  const before = title.slice(0, idx).trim();
  return before || title;
}

/** Живая строка по контракту: `{кадр} {N} {узел} › {сценарий} › {шаг} {SS.S}` (в ASCII-профиле разделитель `|`).
 * Счётчик времени теста идёт в конце и опускается только вместе со всей строкой:
 * до первого шага строка — `{кадр} {N} {узел} › {сценарий} {SS.S}`.
 */
export function formatLiveLine(frame: string, ordinal: number, label: string, labelWidth: number, title: string, step: string | null, elapsed: string, separator: string): string {
  const base = `${INDENT}${frame} ${ordinal} ${label.padEnd(labelWidth)} ${separator} ${title}`;
  const withStep = step === null ? base : `${base} ${separator} ${step}`;
  return `${withStep} ${elapsed}`;
}

/** Счётчик времени теста: секунды с десятой (`7.3`) — фиксированная ширина 4 символа до 100 с,
 * дальше ширина растёт разово, а не каждый такт. Прогоны короче минуты: минуты не считаем.
 */
export function formatElapsed(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

export function verdictMark(ascii: boolean, status: TestResult['status'], expectedStatus: TestCase['expectedStatus']): { symbol: string; kind: 'ok' | 'skipped' | 'fail'; note: string } {
  if (status === 'skipped') { return { symbol: '-', kind: 'skipped', note: '' }; }
  if (status === 'passed' && expectedStatus === 'passed') { return { symbol: ascii ? 'ok' : '✓', kind: 'ok', note: '' }; }
  const note = status === 'timedOut' ? ' (таймаут теста)' : status === 'interrupted' ? ' (прерван)' : '';
  return { symbol: ascii ? 'x' : '✘', kind: 'fail', note };
}

export function firstErrorLine(result: TestResult, ascii = false): string | null {
  const fallback = result.errors && result.errors.length > 0 ? result.errors[0] : undefined;
  const error = result.error ? result.error : fallback;
  if (!error) { return null; }
  const raw = error.message !== undefined ? error.message : error.value !== undefined ? String(error.value) : '';
  const line = stripAnsi(raw).split(/\r?\n/).find(l => l.trim().length > 0);
  if (!line) { return null; }
  if (line.length <= 200) { return line; }
  // ASCII-профиль: многоточие из ASCII — в cp1251-консоли юникодный `…` дал бы мажибake.
  return ascii ? `${line.slice(0, 200)}...` : `${line.slice(0, 200)}…`;
}

export default class LiveReporter implements Reporter {
  private readonly tty = Boolean(process.stdout.isTTY);
  private readonly ascii = ASCII_TERMINAL;
  private readonly color = this.tty && !process.env.NO_COLOR;
  private readonly sep = this.ascii ? '|' : '›';
  // Порядок вставки = порядок onTestBegin: Map служит и списком живых строк.
  private readonly active = new Map<TestResult, { ordinal: number; label: string; title: string; step: string | null; startedAt: number }>();
  private pendingPermanent: string[] = [];
  private liveLinesDrawn = 0;
  private paddedTop = false;
  private frameIndex = 0;
  // Длины последнего нарисованного кадра — пересчёт рядов после reflow (сброс при ресайзе).
  private lastFrameLengths: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  // Дебаунс ресайза: события идут непрерывным потоком, пока пользователь двигает рамку.
  private resizePending = false;
  private lastResizeAt = 0;
  private nextOrdinal = 1;
  /** Ширина метки узла — самое длинное известное имя: колонки не «плывут». */
  private labelWidth = 0;
  private okCount = 0;
  private xCount = 0;
  private skippedCount = 0;

  printsToStdio(): boolean {
    return true;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.safe(() => {
      // Шапка прогона не печатается: узлы видны по живым строкам.
      this.labelWidth = suite.suites.reduce((w, s) => Math.max(w, (s.project() || { name: '' }).name.length), 0);
      if (this.tty) {
        process.stdout.on('resize', this.onResize);
        this.timer = setInterval(() => this.safe(() => this.redraw()), 100);
        this.timer.unref();
      }
    });
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.safe(() => {
      const entry = { ordinal: this.nextOrdinal, label: this.labelFor(test), title: test.title, step: null as string | null, startedAt: Date.now() };
      this.nextOrdinal += 1;
      this.labelWidth = Math.max(this.labelWidth, entry.label.length);
      this.active.set(result, entry);
      if (this.tty) {
        if (!this.paddedTop) {
          // Отступ сверху живой области: первая живая строка не висит под промптом.
          this.paddedTop = true;
          this.pendingPermanent.push('');
        }
        this.redraw();
        return;
      }
      process.stdout.write(`${timePrefix()} старт ${entry.ordinal} ${entry.label} ${this.sep} ${entry.title}\n`);

    });
  }

  onStepBegin(_test: TestCase, result: TestResult, step: TestStep): void {
    if (step.category !== 'test.step') { return; } // hooks/expect в подпись не попадают
    this.safe(() => {
      const entry = this.active.get(result);
      if (entry) { entry.step = stepCaption(step.title); } // не стирается на onStepEnd
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.safe(() => {
      const entry = this.active.get(result);
      this.active.delete(result);
      const ordinal = entry ? entry.ordinal : 0;
      const label = entry ? entry.label : this.labelFor(test);
      const title = entry ? entry.title : test.title;

      const mark = verdictMark(this.ascii, result.status, test.expectedStatus);
      if (mark.kind === 'ok') { this.okCount += 1; } else if (mark.kind === 'skipped') { this.skippedCount += 1; } else { this.xCount += 1; }

      // Строка собирается в plain, обрезается, потом окрашивается: ANSI-коды ширину не сбивают.
      // Отступ слева — только TTY-профиль: plain-лог с якорем времени не меняем.
      const symbolPlain = mark.symbol.padEnd(this.ascii ? 2 : 1);
      let plain = `${symbolPlain} ${ordinal} ${label} ${this.sep} ${title}`;
      if (mark.kind !== 'skipped') { plain += ` (${(result.duration / 1000).toFixed(1)}с)`; }
      plain += mark.note;
      plain = this.clip(this.tty ? `${INDENT}${plain}` : plain); // перенос постоянной строки сломал бы подсчёт рядов живой области
      const symbolStart = this.tty ? INDENT.length : 0;
      const line =
        `${plain.slice(0, symbolStart)}` +
        `${this.colorize(plain.slice(symbolStart, symbolStart + symbolPlain.length), mark.kind)}` +
        `${plain.slice(symbolStart + symbolPlain.length)}`;
      this.printPermanent(this.tty ? line : `${timePrefix()} ${plain}`);

      const errLine = mark.kind === 'fail' ? firstErrorLine(result, this.ascii) : null;
      if (errLine) {
        const text = this.clip(this.tty ? `${INDENT}    ${errLine}` : `    ${errLine}`);
        this.printPermanent(this.color ? `${SGR_RED}${text}${SGR_RESET}` : text);
      }
      if (this.tty) { this.printPermanent(''); }
    });
  }

  onStdOut(chunk: string | Buffer): void { this.emitChunk(chunk, false); }
  onStdErr(chunk: string | Buffer): void { this.emitChunk(chunk, true); }
  onError(error: TestError): void {
    this.safe(() => {
      const raw = error.stack ? error.stack : error.message !== undefined ? error.message : error.value !== undefined ? String(error.value) : '';
      this.printPermanent('ОШИБКА:');
      for (const line of stripAnsi(raw).split(/\r?\n/)) { this.printPermanent(this.clip(line)); }
    });
  }

  onEnd(result: FullResult): void {
    // Таймер останавливается первым делом и вне safe() — в любом случае.
    if (this.timer) { clearInterval(this.timer); }
    this.timer = null;
    process.stdout.off('resize', this.onResize);
    this.safe(() => {
      if (this.resizePending) {
        // Таймер остановлен — дебаунс не отработает: сброс делаем сами. Счётчик рядов после
        // reflow невалиден — стирание идёт по свежему пересчёту (applyResizeReset).
        this.resizePending = false;
        this.applyResizeReset();
      }
      this.eraseLiveArea();
      if (this.tty) { this.printPermanent(''); } // padding перед сводкой
      const parts = [`${this.okCount} ok`, `${this.xCount} x`];
      if (this.skippedCount > 0) { parts.push(`${this.skippedCount} пропущено`); }
      const note = result.status === 'interrupted' ? ' (прервано)' : result.status === 'timedout' ? ' (глобальный таймаут)' : '';
      process.stdout.write(`Готово за ${(result.duration / 1000).toFixed(1)}с: ${parts.join(', ')}${note}\n`);
    });
  }

  // conhost reflow'ит буфер при смене ширины: счётчик рядов перестаёт соответствовать экрану,
  // стирать её механизмом ресайза нельзя. Сброс дебаунсится: событий много, реакция — одна
  // (redraw), после тишины (см. RESIZE_QUIET_MS).
  private readonly onResize = (): void => this.safe(() => {
    if (!this.tty) { return; }
    this.resizePending = true;
    this.lastResizeAt = Date.now();
  });

  /**
   * Стирание живой области после драга. Пока драг шёл, redraw молчал — курсор стоит сразу
   * под областью, а reflow переносит длинные строки предсказуемо: строка длины L занимает
   * ceil(L / ширина) рядов. Стерев ряды, курсор возвращаем на ВЕРХ стёртой области (как в
   * eraseLiveArea): новый кадр встаёт ровно на место старого — иначе каждый ресайз сдвигал
   * бы область вниз на пустую строку.
   */
  private applyResizeReset(): void {
    const columns = process.stdout.columns || 80;
    let rows = 0;
    for (const len of this.lastFrameLengths) { rows += Math.max(1, Math.ceil(len / columns)); }
    if (rows > 0) {
      process.stdout.write(`\u001B[${rows}A` + '\r\u001B[2K\n'.repeat(rows) + `\u001B[${rows}A`);
    }
    this.liveLinesDrawn = 0;
  }

  /** Видимая ширина постоянной строки — как у живых: консоль минус 1. */
  private permanentWidth(): number {
    return Math.max(1, (process.stdout.columns || 80) - 1);
  }

  /** Обрезка постоянной строки под ширину TTY; plain-профиль (лог-файл) не трогаем. */
  private clip(text: string): string {
    return this.tty ? truncate(text, this.permanentWidth()) : text;
  }

  private labelFor(test: TestCase): string {
    const project = test.parent.project();
    if (project && project.name) { return project.name; }
    const segments = test.titlePath().filter(Boolean);
    return segments.length > 0 ? segments[0] : test.title;
  }

  private emitChunk(chunk: string | Buffer, isErr: boolean): void {
    // В TTY stderr идёт через stdout: два асинхронных потока рядом с управлением
    // курсором порядок не гарантируют.
    this.safe(() => {
      const text = chunk.toString();
      if (!this.tty) {
        (isErr ? process.stderr : process.stdout).write(text);
        return;
      }

      // Чанк воркера построчно — как постоянные строки; хвост без \n дописывается.
      const lines = (text.endsWith('\n') ? text : `${text}\n`).split('\n');
      lines.pop(); // пустая строка от split после завершающего \n
      this.pendingPermanent.push(...lines);
      this.redraw();
    });
  }

  private printPermanent(text: string): void {
    const line = text.replace(/\r?\n$/, '');
    if (!this.tty) {
      process.stdout.write(`${line}\n`);
      return;
    }

    this.pendingPermanent.push(line);
    this.redraw();
  }

  private colorize(text: string, kind: 'ok' | 'skipped' | 'fail'): string {
    if (!this.color) { return text; }
    const code = kind === 'ok' ? SGR_GREEN : kind === 'fail' ? SGR_RED : SGR_DIM;
    return `${code}${text}${SGR_RESET}`;
  }

  // Кадр живой области: подняться на число нарисованных строк, напечатать постоянные
  // и живые, лишние стереть. Подмножество CSI как у встроенного list-reporter'а.
  private redraw(): void {
    if (!this.tty) { return; }
    if (this.resizePending) {
      // Драг продолжается: в reflow'ящийся буфер не рисуем — каждый кадр встал бы на новый ряд.
      if (Date.now() - this.lastResizeAt < RESIZE_QUIET_MS) { return; }
      this.resizePending = false;
      this.applyResizeReset();
    }
    this.frameIndex += 1;
    const width = this.permanentWidth();
    const maxLive = Math.max(1, (process.stdout.rows || 24) - 2);
    const visible = Array.from(this.active.values()).slice(0, maxLive);
    const hidden = this.active.size - visible.length;

    const liveLines = visible.map(entry => this.renderLiveLine(entry, width));
    if (hidden > 0) { liveLines.push(truncate(`${INDENT}${this.ascii ? `... ещё ${hidden}` : `… ещё ${hidden}`}`, width)); }
    // Видимые длины кадра: сброс при ресайзе пересчитывает ряды после reflow (см. applyResizeReset).
    this.lastFrameLengths = liveLines.map(l => stripAnsi(l).length);

    let out = this.liveLinesDrawn > 0 ? `\u001B[${this.liveLinesDrawn}A` : '';
    for (const p of this.pendingPermanent) { out += `\r\u001B[2K${p}\n`; }
    this.pendingPermanent = [];
    for (const l of liveLines) { out += `\r\u001B[2K${l}\n`; }
    const deficit = this.liveLinesDrawn - liveLines.length;
    if (deficit > 0) { out += '\r\u001B[2K\n'.repeat(deficit) + `\u001B[${deficit}A`; }
    this.liveLinesDrawn = liveLines.length;
    process.stdout.write(out);
  }

  private renderLiveLine(entry: { ordinal: number; label: string; title: string; step: string | null; startedAt: number }, width: number): string {
    const frames = this.ascii ? ASCII_SPINNER : BRAILLE_SPINNER;
    const frame = frames[this.frameIndex % frames.length];
    const elapsed = formatElapsed(Date.now() - entry.startedAt);
    const plain = truncate(formatLiveLine(frame, entry.ordinal, entry.label, this.labelWidth, entry.title, entry.step, elapsed, this.sep), width);
    if (!this.color) { return plain; }
    // Тусклый только кадр спиннера: он идёт после INDENT, а не в колонке 0.
    return `${plain.slice(0, INDENT.length)}${SGR_DIM}${plain.slice(INDENT.length, INDENT.length + 1)}${SGR_RESET}${plain.slice(INDENT.length + 1)}`;
  }

  /** Финальная очистка: курсор не должен «застревать» в конце живой строки. */
  private eraseLiveArea(): void {
    if (!this.tty || this.liveLinesDrawn === 0) { return; }
    const count = this.liveLinesDrawn;
    process.stdout.write(`\u001B[${count}A` + '\r\u001B[2K\n'.repeat(count) + `\u001B[${count}A`);
    this.liveLinesDrawn = 0;
  }

  /** Сбой печати не роняет прогон: печать — не проверка. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // сбой печати игнорируется
    }
  }
}
