/**
 * Библиотека сценария веб-кабинета: шаги входа/раздела, общий прогон
 * сценария и сверка порогов. Живёт в specs/ — это предметная область сценариев;
 * ядро (helpers/, scripts/) её не импортирует.
 */
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { loadConfig, TIMEOUTS, type MonitorConfig, type Threshold } from '../helpers/config';
import { recordMetric, runId, type MetricResult } from '../helpers/metrics';
import { screenshotPath } from '../helpers/artifacts';

export interface Credentials {
  login: string;
  password: string;
}

/** Шаги «в»/«г»: тур и сужение до таблицы дня X. По умолчанию — первый тур, дерево или таблица. */
export interface RoundOpts {
  dayXOnly?: boolean;
  secondRound?: boolean;
}

/** Якорь раздела и `data-qual-stage` тура меняются вместе. */
const ROUNDS = {
  first: { anchor: '#olympregisteredfirst', qualStage: 'oqsFirst' },
  second: { anchor: '#olympregistered', qualStage: 'oqsSecond' }
} as const;

function round(opts?: RoundOpts): (typeof ROUNDS)[keyof typeof ROUNDS] {
  return opts?.secondRound ? ROUNDS.second : ROUNDS.first;
}

/**
 * Шаг «а»: открыть school.html; замер — от начала навигации до видимого поля логина.
 * `domcontentloaded`, а не `networkidle`: фоновые запросы (аналитика, счётчики) добавляют
 * к замеру десятки секунд.
 */
export async function openSigninPage(page: Page, url: string): Promise<number> {
  const started = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Готовность — видимое поле логина: кабинет собирает Dojo уже после отдачи HTML.
  await loginField(page).waitFor({ state: 'visible', timeout: TIMEOUTS.stepMs });
  const elapsed = Date.now() - started;

  // GDPR-плашку приносит сторонний скрипт, бывает позже поля; незакрытая перекрывает
  // форму. Ждём коротко, вне замера.
  const gdprClose = page.getByTestId('gdpr-close');
  const banner = await gdprClose
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (banner) {
    await gdprClose.click();
  }
  return elapsed;
}

/**
 * Шаг «б»: войти; замер — от нажатия кнопки до внутренней части кабинета.
 *
 * Отказ во входе ловится сразу, не по таймауту: класс `red` на `.officeAuthorizationStatus`
 * (он вне `<form>` — ищется через `closest()` от `login-username`) или на `.officeAnnouncement`.
 * `data-testid` у сообщения нет, а узел статуса есть в DOM всегда (`opacity: 0` Playwright
 * считает видимым) — поэтому сигнал только класс.
 */
export async function login(page: Page, credentials: Credentials): Promise<number> {
  await loginField(page).fill(credentials.login);
  await page.getByTestId('login-password').locator('input:not([readonly])').fill(credentials.password);

  const loginForm = page.locator('form').filter({ has: page.getByTestId('login-username') });

  const started = Date.now();
  await loginForm.getByTestId('form-submit').click();
  const outcome = await page.waitForFunction(
    () => {
      if (window.location.hash !== '#signin') {
        return { ok: true };
      }
      const usernameField = document.querySelector('[data-testid="login-username"]');
      const wrapper = usernameField ? usernameField.closest('.officeFormContentFormWrapper') : null;
      const errorNode = wrapper
        ? wrapper.querySelector('.officeAuthorizationStatus.red, .officeAnnouncement.red')
        : null;
      if (errorNode) {
        const text = (errorNode.textContent || '').replace(/\s+/g, ' ').trim();
        return { error: text };
      }
      return null;
    },
    { timeout: TIMEOUTS.stepMs }
  );
  // waitForFunction ждёт truthy: null сюда не доходит, `!` — только для типа.
  const value = (await outcome.jsonValue())!;
  if ('error' in value) {
    const text = value.error || '(текст сообщения пуст)';
    throw new Error(`Вход отклонён сервером: ${text}`);
  }
  await page.getByTestId('cabinet-internal').waitFor({ state: 'visible', timeout: TIMEOUTS.stepMs });
  return Date.now() - started;
}

/**
 * Шаг «в»: перейти в раздел; замер — от смены якоря до дерева раздела или, в день X,
 * таблицы дня X (с `dayXOnly` — только таблицы). Видимое дерево значит, что раздел
 * загрузился, а не показал заглушку. Метрика `section_ms` общая для туров и дня X —
 * под этим именем пороги в `env*.json`.
 */
export async function openRound(page: Page, opts?: RoundOpts): Promise<number> {
  const started = Date.now();
  await page.evaluate(hash => {
    window.location.hash = hash;
  }, round(opts).anchor);

  // `.first()`: без него strict mode падает, когда видимы оба варианта — дерево и таблица
  // дня X (переходный момент в день X; фиктивный кабинет рисует оба всегда).
  await sectionReady(page, opts).first().waitFor({ state: 'visible', timeout: TIMEOUTS.stepMs });
  return Date.now() - started;
}

/**
 * Шаг «г»: таблица раздела (`olymp-exam-list` или `olymp-dayx-table`) видна и непуста;
 * строки в обоих — `olymp-exam-item`. Проверка положительная: отсутствие заглушки
 * «нет записей» ничего не доказывает.
 */
export async function readExamTable(page: Page, opts?: RoundOpts): Promise<{ list: Locator; count: number }> {
  // `.first()`: без него strict mode падает, когда видимы обе таблицы — дня X и «Состязания».
  const list = examList(page, opts).first();
  await list.waitFor({ state: 'visible', timeout: TIMEOUTS.stepMs });

  const items = list.locator('[data-testid="olymp-exam-item"]');
  await items.first().waitFor({ state: 'visible', timeout: TIMEOUTS.stepMs });

  return { list, count: await items.count() };
}

/** Пауза на анимации перед снимком успеха. Прокрутка не нужна — см. `viewport` в `playwright.config.ts`. */
export async function settleBeforeScreenshot(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_BEFORE_SCREENSHOT_MS);
}

export const SETTLE_BEFORE_SCREENSHOT_MS = 500;

/** Корень раздела тура. Всё ищется внутри него — раздел другого тура, оставшийся в DOM, не мешает. */
function section(page: Page, opts?: RoundOpts): Locator {
  return page.locator(`[data-testid="olymp-section"][data-qual-stage="${round(opts).qualStage}"]`);
}

/**
 * Готовый раздел: дерево или таблица дня X, что появится; с `dayXOnly` — только таблица.
 * Фильтр по видимости: в день X скрытое дерево стоит в DOM раньше таблицы — без него `.or()`
 * упал бы по strict-mode, а `.first()` взял бы скрытое дерево.
 */
function sectionReady(page: Page, opts?: RoundOpts): Locator {
  if (opts?.dayXOnly) {
    return dayXTable(page, opts);
  }
  return dayXTable(page, opts).or(roundTree(page, opts)).filter({ visible: true });
}

/** Список записей раздела: таблица «Состязания» или таблица дня X; с `dayXOnly` — только она. */
function examList(page: Page, opts?: RoundOpts): Locator {
  if (opts?.dayXOnly) {
    return dayXTable(page, opts);
  }
  return dayXTable(page, opts)
    .or(section(page, opts).locator('[data-testid="olymp-exam-list"]'))
    .filter({ visible: true });
}

function roundTree(page: Page, opts?: RoundOpts): Locator {
  return section(page, opts).locator('[data-testid="olymp-round-tree"]');
}

function dayXTable(page: Page, opts?: RoundOpts): Locator {
  return section(page, opts).locator('[data-testid="olymp-dayx-table"]');
}

function loginField(page: Page): Locator {
  // Виджеты office.form.* рисуют два <input>, видимый и readonly-дубль.
  return page.getByTestId('login-username').locator('input:not([readonly])');
}

// --- Общий прогон сценария --------------------------------------------------

/** Имена метрик поставляемых сценариев кабинета. */
export const SCENARIO_METRICS = ['signin_page_ms', 'login_ms', 'section_ms'] as const;

/**
 * Человеческие подписи метрик — часть сценария, не ядра:
 * отчёт читает их из вложения `timings` (поле `labels`) и показывает вместо сырых имён.
 */
export const SCENARIO_METRIC_LABELS: Record<string, string> = {
  signin_page_ms: 'Страница входа',
  login_ms: 'Вход в кабинет',
  section_ms: 'Раздел кабинета'
};

/** Заголовок отчёта — текст сценария; у ядра без него нейтральный fallback. */
export const SCENARIO_REPORT_TITLE = 'Мониторинг веб-кабинета';

/** Легенда метрик в конце отчёта — расшифровка шагов сценария. */
export const SCENARIO_REPORT_LEGEND = [
  'Страница входа — от открытия страницы до появления поля логина.',
  'Вход в кабинет — от нажатия входа до появления кабинета.',
  'Раздел кабинета — от перехода в раздел тура до готового раздела.'
];

/** Опции прогона сценария: раздел тура (тур/день X) или только вход. */
export interface CabinetScenarioOptions {
  /** Шаги «Раздел кабинета» и «Таблица раздела» с этими опциями раздела; без них — только вход. */
  round?: RoundOpts;
}

/**
 * Пороги по именам метрик сценария: отсутствующий в конфиге порог — ошибка
 * с именем метрики. Спеки вызывают при загрузке модуля, так что промах с конфигом падает
 * до первого входа на страницу.
 */
export function thresholdsFor(
  cfg: MonitorConfig,
  names: readonly string[] = SCENARIO_METRICS
): Record<string, Threshold> {
  const out: Record<string, Threshold> = {};
  for (const name of names) {
    const t = cfg.thresholds[name];
    if (!t || typeof t.reference !== 'number' || typeof t.maxRatio !== 'number') {
      throw new Error(
        `сценарий "${cfg.scenario}": не задан порог thresholds.${name} ({ reference, maxRatio }) — ` +
          'для каждой метрики сценария в конфиге нужен свой порог.'
      );
    }
    out[name] = t;
  }
  return out;
}

/**
 * Тело сценария кабинета: шаги входа, опционально раздел, снимок в любом исходе и
 * вложение `timings` (его читает scripts/report.mjs). Тонкие spec-файлы
 * поставляемых сценариев — вызовы этой функции со своими опциями раздела.
 */
export async function runCabinetScenario(
  page: Page,
  testInfo: TestInfo,
  options: CabinetScenarioOptions
): Promise<void> {
  const config = loadConfig();
  const runIdValue = runId();
  const thresholds = thresholdsFor(config, options.round ? SCENARIO_METRICS : SCENARIO_METRICS.slice(0, 2));

  const roundLabel = options.round?.secondRound ? 'второго' : 'первого';
  const stepRoundTitle = options.round?.dayXOnly
    ? `Раздел кабинета: ${roundLabel} тур, таблица дня X`
    : `Раздел кабинета: ${roundLabel} тур, дерево раздела или таблица дня X`;

  const { target, url } = testInfo.project.metadata as { target: string; url: string };
  const ctx = { environment: config.environment, target, url, runId: runIdValue };
  const results: MetricResult[] = [];
  let examCount = 0;
  let failed = true;

  try {
    await test.step('Страница входа', async () => {
      const ms = await openSigninPage(page, url);
      results.push(recordMetric(ctx, 'signin_page_ms', ms, thresholds.signin_page_ms));
    });

    await test.step('Вход в кабинет', async () => {
      const ms = await login(page, { login: config.login, password: config.password });
      results.push(recordMetric(ctx, 'login_ms', ms, thresholds.login_ms));
      // Отличает «кабинет открылся» от «атрибут не найден»: блок анонимной части при входе исчезает.
      await expect(page.locator('#external')).toHaveCount(0);
    });

    if (options.round) {
      await test.step(stepRoundTitle, async () => {
        const ms = await openRound(page, options.round);
        results.push(recordMetric(ctx, 'section_ms', ms, thresholds.section_ms));
      });

      await test.step('Таблица раздела', async () => {
        const table = await readExamTable(page, options.round);
        examCount = table.count;
        expect(examCount, `таблица раздела ${roundLabel} тура пуста`).toBeGreaterThan(0);
      });
    }

    failed = false;
  } finally {
    try {
      await test.step('Снимок экрана', () => captureScreenshot(page, testInfo, target, runIdValue, failed));
    } catch {
      // Сбой test.step() вокруг снимка не подменяет причину падения.
    }
  }

  // Вложение `timings` читает scripts/report.mjs: по metrics[].failure он узнаёт падение по
  // порогу, поля `labels`/`title`/`legend` — человеческий текст отчёта (подписи метрик,
  // заголовок, легенда) — часть сценария, не ядра.
  await testInfo.attach('timings', {
    body: JSON.stringify(
      {
        run_id: runIdValue,
        environment: config.environment,
        target,
        url,
        scenario: config.scenario,
        exam_count: examCount,
        labels: SCENARIO_METRIC_LABELS,
        title: SCENARIO_REPORT_TITLE,
        legend: SCENARIO_REPORT_LEGEND,
        metrics: results
      },
      null,
      2
    ),
    contentType: 'application/json'
  });

  const slow = results.filter(r => r.failure);
  expect(slow.map(r => r.failure).join('\n'), slow.map(r => r.failure).join('\n')).toBe('');
}

/** Снимок в любом исходе, целой страницей: при успехе — с таблицей раздела, при падении — момент отказа. */
async function captureScreenshot(
  page: Page,
  testInfo: TestInfo,
  target: string,
  runIdValue: string,
  failed: boolean
): Promise<void> {
  const file = screenshotPath(runIdValue, target, failed ? 'fail' : 'pass', testInfo);
  // Снимок — сверх бюджета теста: иначе таймаут теста на зависшей странице подменил бы
  // настоящую причину падения. 0 — таймаута нет.
  if (testInfo.timeout > 0) {
    testInfo.setTimeout(testInfo.timeout + SCREENSHOT_BUDGET_MS);
  }
  try {
    if (!failed) {
      await settleBeforeScreenshot(page);
    }
    await page.screenshot({ path: file, fullPage: true, timeout: TIMEOUTS.actionMs });
    await testInfo.attach(`screenshot-${failed ? 'fail' : 'pass'}`, { path: file, contentType: 'image/png' });
  } catch {
    // Снимок — диагностика: его сбой не подменяет причину падения.
  }
}

/** Пауза перед снимком успеха, сам снимок и секунда на вложение. */
const SCREENSHOT_BUDGET_MS = SETTLE_BEFORE_SCREENSHOT_MS + TIMEOUTS.actionMs + 1_000;
