/**
 * Фиктивный кабинет олимпиад школьников: настоящие `specs/olymp-first-round.spec.ts` и
 * `monitor.bat` бандла проходят через него без сети.
 * Только встроенные модули Node; разметка повторяет форму входа реального кабинета
 * (узел статуса `.officeAuthorizationStatus` вне <form>, класс `red`/`blue` для
 * ошибки/загрузки, testid-атрибуты кабинета).
 *
 * Поведение узла — таблица NODE_BEHAVIOR ниже:
 *   ok1             — обычный, без задержек и без брака.
 *   slowOnce        — задержка DELAY_MS на первый запрос страницы узла,
 *                      дальше без задержки (счётчик в памяти процесса).
 *   slowAlways      — задержка на каждый запрос.
 *   slowOnceBroken  — задержка только на первый запрос, и блок #external
 *                      не удаляется после входа — шаг «вход» падает.
 *   loginErr        — вход всегда показывает ошибку.
 *   stalled         — на запрос страницы ответ не отправляется никогда: шаг «Страница
 *                      входа» падает по таймауту навигации, замер не пишется — такой
 *                      узел не должен попадать в перепроверку (нет verdict=slow).
 *
 * Режимы (`[ИМЯ=ЗНАЧЕНИЕ…]` — варианты прогона, уходят в `monitor.bat` аргументами):
 *   --serve                                  — только сервер;
 *   --bat <конфиг> [ИМЯ=ЗНАЧЕНИЕ…]           — сервер и `monitor.bat` как из консоли;
 *   --explorer <конфиг> <клавиша> [ИМЯ=ЗНАЧЕНИЕ…] — сервер и `monitor.bat` как двойной клик
 *       из Проводника (`cmd /c ""<bat>" "<конфиг>" "`: хвостовой пробел включает
 *       FROM_EXPLORER); отчёт печатается целиком без вопроса, в конце shim ждёт клавишу —
 *       `<клавиша>` (`enter` или текст) уходит в stdin для этой паузы.
 * По завершении `monitor.bat` сервер закрывается, код возврата — код `monitor.bat`. Любой
 * сбой самой обвязки — код 2 и строка `[fake-cabinet] …` с причиной.
 * Конфиг — путь относительно текущего каталога. `MONITOR_*` оболочки до `monitor.bat` не
 * доходят — варианты прогона задаются только аргументами; результаты — всегда в
 * `artifacts\_dev` бандла, не в рабочий `artifacts`. Принимаются только варианты прогона
 * (`VARIANT_NAMES`) — конфиг идёт позиционным аргументом, каталог результатов задаёт
 * обвязка, id прогона — globalSetup. Значение проверяется только на безопасность строки cmd
 * (`PAIR_RE`): фильтр защищает строку `cmd /c` самой обвязки и строже, чем `monitor.bat`.
 * `cmd /c` раскрывает пары `%ИМЯ%` до того, как строку увидит `monitor.bat`, а двойная
 * кавычка внутри значения сломала бы кавычки всей строки `cmd /c`. Литеральную передачу
 * метасимволов (`& | < > ^ !`) самим `monitor.bat` проверяет `./tests/bat-args.mjs`, а не
 * этот фильтр.
 * `%` в значении здесь допускается только в конце (`MONITOR_WORKERS=25%`): несколько таких
 * `%` на строке cmd /c безопасны — текст между ними начинается с `"`, такой переменной нет,
 * а неопределённую ссылку cmd /c оставляет как есть. Смысл значения обвязка не проверяет.
 *
 * Запуск из каталога бандла через `node` (не `cmd.exe` из Git Bash: `/c` там стал бы путём):
 *   node ./tests/fake-cabinet.mjs --bat ./tests/env.fake-full.json
 */
import * as http from 'http';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const HOST = '127.0.0.1';
const PORT = 18480;
const DELAY_MS = 1500;

const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** delay: 'never' | 'once' | 'always' | 'stall'; broken — #external никогда не удаляется. */
const NODE_BEHAVIOR = {
  ok1: { delay: 'never', broken: false, loginErr: false },
  slowOnce: { delay: 'once', broken: false, loginErr: false },
  slowAlways: { delay: 'always', broken: false, loginErr: false },
  slowOnceBroken: { delay: 'once', broken: true, loginErr: false },
  loginErr: { delay: 'never', broken: false, loginErr: true },
  stalled: { delay: 'stall', broken: false, loginErr: false },
};

const requestCounts = new Map();

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function renderPage(node, behavior) {
  const flags = JSON.stringify({ node, broken: behavior.broken, loginErr: behavior.loginErr });
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>school</title>
<style>
  .officeAuthorizationStatus { opacity: 0; }
  [data-testid="cabinet-internal"] { display: none; }
</style>
</head>
<body>
<script>window.FAKE = ${flags};</script>
<div data-testid="gdpr-close-wrapper">
  <span>Мы используем куки</span>
  <button type="button" data-testid="gdpr-close">Понятно</button>
</div>
<div id="external">
  <div class="officeFormContentHeader">Войти в Личный кабинет</div>
  <div class="officeFormContentFormWrapper">
    <div></div>
    <div class="officeFormField">
      <div class="officeAuthorizationStatus">
        <span class="officeAuthorizationStatus-icon"></span>
        <span class="officeAuthorizationStatus-text"></span>
      </div>
    </div>
    <form>
      <div data-testid="login-username">
        <input type="text" readonly>
        <input type="text">
      </div>
      <div data-testid="login-password">
        <input type="password" readonly>
        <input type="password">
      </div>
      <button type="button" data-testid="form-submit">Войти</button>
    </form>
  </div>
</div>
<div data-testid="cabinet-internal">Личный кабинет</div>
<script>
(function () {
  if (!window.location.hash) {
    window.location.hash = '#signin';
  }

  document.querySelector('[data-testid="gdpr-close"]').addEventListener('click', function () {
    document.querySelector('[data-testid="gdpr-close-wrapper"]').style.display = 'none';
  });

  document.querySelector('[data-testid="form-submit"]').addEventListener('click', function () {
    var statusNode = document.querySelector('.officeAuthorizationStatus');
    var textNode = document.querySelector('.officeAuthorizationStatus-text');
    if (window.FAKE.loginErr) {
      setTimeout(function () {
        statusNode.classList.remove('blue', 'green');
        statusNode.classList.add('red');
        textNode.textContent = 'Ошибка: неверный логин или пароль';
        statusNode.style.opacity = '1';
      }, 200);
      return;
    }
    statusNode.classList.remove('red', 'green');
    statusNode.classList.add('blue');
    textNode.textContent = 'Загрузка данных';
    statusNode.style.opacity = '1';
    setTimeout(function () {
      window.location.hash = '#internal';
      document.querySelector('[data-testid="cabinet-internal"]').style.display = 'block';
      if (!window.FAKE.broken) {
        var ext = document.getElementById('external');
        if (ext) {
          ext.remove();
        }
      }
    }, 300);
  });

  window.addEventListener('hashchange', function () {
    var hash = window.location.hash;
    var qualStage = hash === '#olympregisteredfirst' ? 'oqsFirst' : hash === '#olympregistered' ? 'oqsSecond' : null;
    if (!qualStage) {
      return;
    }
    setTimeout(function () {
      var container = document.querySelector('[data-testid="cabinet-internal"]');
      var existing = container.querySelectorAll('[data-testid="olymp-section"]');
      for (var i = 0; i < existing.length; i += 1) {
        existing[i].remove();
      }
      var section = document.createElement('div');
      section.setAttribute('data-testid', 'olymp-section');
      section.setAttribute('data-qual-stage', qualStage);
      var tree = document.createElement('div');
      tree.setAttribute('data-testid', 'olymp-round-tree');
      tree.textContent = 'Дерево олимпиад';
      section.appendChild(tree);
      var list = document.createElement('div');
      list.setAttribute('data-testid', 'olymp-exam-list');
      // Таблица дня X рисуется тоже: сценарии olymp-dayx и olymp-second-dayx ждут
      // именно её — на фиктивном кабинете все поставляемые сценарии должны проходить.
      var dayx = document.createElement('div');
      dayx.setAttribute('data-testid', 'olymp-dayx-table');
      for (var j = 0; j < 2; j += 1) {
        var item = document.createElement('div');
        item.setAttribute('data-testid', 'olymp-exam-item');
        item.textContent = 'Состязание ' + (j + 1);
        list.appendChild(item);
        var dayxItem = document.createElement('div');
        dayxItem.setAttribute('data-testid', 'olymp-exam-item');
        dayxItem.textContent = 'Состязание дня X ' + (j + 1);
        dayx.appendChild(dayxItem);
      }
      section.appendChild(list);
      section.appendChild(dayx);
      container.appendChild(section);
    }, 100);
  });
})();
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  const match = /^\/([^/]+)\/school\.html$/.exec(url.pathname);
  if (req.method === 'GET' && match) {
    const node = match[1];
    const behavior = NODE_BEHAVIOR[node];
    if (!behavior) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`unknown node: ${node}`);
      return;
    }

    const count = (requestCounts.get(node) || 0) + 1;
    requestCounts.set(node, count);
    if (behavior.delay === 'stall') {
      // Ответа нет никогда: навигация падает по таймауту. Сокет остаётся висеть —
      // server.closeAllConnections() в обработчике выхода их закроет.
      return;
    }
    const shouldDelay = behavior.delay === 'always' || (behavior.delay === 'once' && count === 1);
    if (shouldDelay) {
      await wait(DELAY_MS);
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage(node, behavior));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const USAGE =
  'Использование: node fake-cabinet.mjs --serve | --bat <конфиг> [ИМЯ=ЗНАЧЕНИЕ…] | ' +
  '--explorer <конфиг> <enter|ответ> [ИМЯ=ЗНАЧЕНИЕ…]';

/** Код возврата сбоя самой обвязки — отличим от кодов `monitor.bat` (0, 1, 3). */
const HARNESS_FAILURE = 2;

/**
 * Окружение `monitor.bat`: без `MONITOR_*` оболочки (оставшийся `MONITOR_CSV` или
 * `MONITOR_TARGET` увёл бы замеры в рабочую историю или сломал прогон). Копия
 * `process.env` — обычный объект, поэтому имена сравниваются без учёта регистра вручную.
 */
function monitorEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('MONITOR_')) {
      env[name] = value;
    }
  }
  env.MONITOR_ARTIFACTS = path.join('artifacts', '_dev');
  return env;
}

/** Запустить monitor.bat рядом с сервером и выйти с его кодом; `answer` — клавиша финальной паузы в stdin. */
function runMonitor(args, answer) {
  const env = monitorEnv();
  // Полный путь к monitor.bat, а не голое имя: при NoDefaultCurrentDirectoryInExePath=1
  // cmd.exe не ищет исполняемые файлы в текущем каталоге. Строка для /c собрана целиком
  // (windowsVerbatimArguments): кавычки Node вокруг путей с пробелами cmd /c снял бы неверно.
  const child = spawn('cmd.exe', args, {
    cwd: BUNDLE_ROOT,
    env,
    windowsVerbatimArguments: true,
    stdio: [answer === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
  child.on('error', e => {
    console.error(`[fake-cabinet] cmd.exe не запустился: ${e.message}`);
    server.close(() => process.exit(HARNESS_FAILURE));
  });
  if (answer !== undefined) {
    // monitor.bat может выйти, не дочитав ответ, — EPIPE (на Windows и EOF) здесь не сбой.
    // Прочее — видно: непереданную клавишу pause прочтёт как конец ввода.
    child.stdin.on('error', e => {
      if (e.code !== 'EPIPE' && e.code !== 'EOF') {
        console.error(`[fake-cabinet] ответ не передан: ${e.message}`);
      }
    });
    child.stdin.end(answer);
  }
  child.on('exit', (code, signal) => {
    // Зависшие сокеты stalled-узла не дают close() дойти до колбека — закрываем сначала.
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(() => {
      if (code === null) {
        console.error(`[fake-cabinet] cmd.exe завершён извне (${signal}), без кода возврата`);
      }
      process.exit(code === null ? HARNESS_FAILURE : code);
    });
  });
}

/** Варианты прогона из README бандла, которые можно передать аргументом. */
const VARIANT_NAMES = ['MONITOR_TARGET', 'MONITOR_WORKERS', 'MONITOR_TIMEOUTS'];
const PAIR_RE = /^([A-Za-z_][A-Za-z0-9_]*)=[A-Za-z0-9_.,:-]*%?$/;

/** Причина, по которой аргумент `ИМЯ=ЗНАЧЕНИЕ` не принят, или `null`. */
function pairProblem(pair) {
  const m = PAIR_RE.exec(pair);
  if (!m) {
    return `"${pair}": нужно ИМЯ=ЗНАЧЕНИЕ; имя — латиница, цифры, _, не с цифры; значение — латиница, цифры, _.,:- и % в конце`;
  }
  if (!VARIANT_NAMES.includes(m[1].toUpperCase())) {
    return `${m[1]} — не вариант прогона; допустимо: ${VARIANT_NAMES.join(', ')}`;
  }
  return null;
}

/** Разбор командной строки: `{ mode, line, answer? }` или `{ error }`. */
function parseArgs(argv) {
  const [mode, config, ...rest] = argv;
  if (mode === '--serve') {
    return config === undefined ? { mode } : { error: '--serve не принимает аргументов' };
  }
  if (mode !== '--bat' && mode !== '--explorer') {
    return { error: 'неизвестный режим' };
  }
  if (!config) {
    return { error: 'не задан конфиг' };
  }
  let answer;
  if (mode === '--explorer') {
    const raw = rest.shift();
    if (!raw || raw.includes('=')) {
      return { error: 'не задана клавиша для финальной паузы (enter или текст) — она идёт перед ИМЯ=ЗНАЧЕНИЕ' };
    }
    answer = raw === 'enter' ? '\r\n' : `${raw}\r\n`;
  }
  for (const pair of rest) {
    const problem = pairProblem(pair);
    if (problem) {
      return { error: problem };
    }
  }
  // `"<bat>" "<конфиг>" "ИМЯ=ЗНАЧЕНИЕ"…` — каждый в кавычках: пробелы в путях. У Проводника
  // строка кончается пробелом — по нему monitor.bat включает FROM_EXPLORER.
  const bat = path.join(BUNDLE_ROOT, 'monitor.bat');
  const quoted = [bat, path.resolve(config), ...rest].map(a => `"${a}"`).join(' ');
  return { mode, line: mode === '--explorer' ? `"${quoted} "` : `"${quoted}"`, answer };
}

server.on('error', e => {
  console.error(`[fake-cabinet] порт ${PORT} не открыт: ${e.message} (не остался ли фоновый --serve?)`);
  process.exit(HARNESS_FAILURE);
});

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  console.error(`[fake-cabinet] ${args.error}`);
  console.error(USAGE);
  process.exit(HARNESS_FAILURE);
}

if (args.mode === '--serve') {
  server.listen(PORT, HOST, () => {
    console.log(`[fake-cabinet] слушает http://${HOST}:${PORT}`);
  });
} else {
  server.listen(PORT, HOST, () => runMonitor(['/d', '/c', args.line], args.answer));
}
