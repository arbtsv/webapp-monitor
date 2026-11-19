/**
 * Обёртка `test:fake`: оба режима фиктивного кабинета `fake-cabinet.mjs` по очереди, с
 * проверкой ожидаемого исхода вместо ручного разбора кода возврата.
 *
 * Два режима:
 *   1. `--bat ./tests/env.fake-full.json` — код 1 и раздел «Перепроверка» со статусами:
 *      медленные узлы перепроверяются (`slowOnce` → норма, `slowAlways` → всё
 *      ещё медленно, `slowOnceBroken` → сбой), stalled-узел по таймауту не перепроверяется,
 *      итог и код — от основного прохода. Код 1 возвращает `monitor.bat` по итогу основного
 *      прогона: в `env.fake-full.json` есть медленные и сломанные узлы. Строка
 *      `ИТОГ: ПРОВАЛ` отличает этот код 1 от кода 1 при поломке отчёта.
 *   2. `--explorer ./tests/env.fake-ok.json enter` — код 0 и строка `ИТОГ: НОРМА` (запуск из
 *      Проводника: отчёт печатается целиком без вопроса, в конце shim ждёт клавишу — ответ
 *      Enter уходит в stdin на паузу).
 * Режимы идут строго по очереди: оба занимают порт фиктивного кабинета 18480. Первый красный
 * исход второй режим не запускает. Занятый порт обёртка не чинит и заранее не проверяет:
 * `fake-cabinet.mjs` сам выходит кодом 2 с причиной, и это красный исход.
 *
 * Запуск: `npm run test:fake` или `node ./tests/run-fake.mjs` из каталога бандла.
 * Коды возврата: 0 — исход ожидаемый, 1 — неожиданный (причина — строкой `[run-fake] …`),
 * 2 — сбой самой обёртки (дочерний процесс не запустился). Вывод режимов идёт на консоль как есть.
 */
import * as path from 'path';
import {
  BUNDLE_ROOT,
  FAIL_VERDICT,
  HARNESS_FAILURE,
  envWithoutMonitor,
  runStep,
} from './run-lib.mjs';

const PREFIX = '[run-fake]';

/** Строка вердикта `ИТОГ: НОРМА` (с необязательным CR) — регулярка без флага `g`. */
const PASS_VERDICT = /^ИТОГ: НОРМА\r?$/m;

/** Раздел «Перепроверка» и статусы узлов в нём. Регэкспы без флага `g`. */
const RECHECK_SECTION = /Перепроверка \(прогон \S+-recheck/;
const RECHECK_LOG = /Перепроверка узлов с превышением порога:/;
const RECHECK_OK = /slowOnce\s+норма/;
const RECHECK_STILL_SLOW = /slowAlways\s+всё ещё медленно/;
const RECHECK_FAIL = /slowOnceBroken\s+сбой/;
/** stalled-узел не должен появляться в разделе «Перепроверка» ни с каким статусом. */
const STALLED_NOT_RECHECKED = [
  /stalled\s+норма/,
  /stalled\s+всё ещё медленно/,
  /stalled\s+сбой/,
  /stalled\s+исход неизвестен/,
  /Перепроверка узлов с превышением порога: [^\r\n]*stalled/,
];

const FAKE = path.join(BUNDLE_ROOT, 'tests', 'fake-cabinet.mjs');

async function main() {
  // Конфиги — относительные пути от каталога бандла: `fake-cabinet.mjs` разворачивает конфиг
  // от текущего каталога, а хелпер запускает дочерний процесс в корне бандла. `MONITOR_*`
  // оболочки отброшены, как в смоуке (сам `fake-cabinet.mjs` отбрасывает их тоже).
  const bat = await runStep(
    PREFIX,
    '--bat env.fake-full.json (прогон + перепроверка)',
    [FAKE, '--bat', './tests/env.fake-full.json'],
    envWithoutMonitor(),
    {
      code: 1,
      markers: [FAIL_VERDICT, RECHECK_SECTION, RECHECK_LOG, RECHECK_OK, RECHECK_STILL_SLOW, RECHECK_FAIL],
      absent: STALLED_NOT_RECHECKED,
    }
  );
  if (bat !== 0) {
    return bat;
  }

  return runStep(
    PREFIX,
    '--explorer env.fake-ok.json enter',
    [FAKE, '--explorer', './tests/env.fake-ok.json', 'enter'],
    envWithoutMonitor(),
    { code: 0, marker: PASS_VERDICT }
  );
}

// Итог — только через process.exitCode: немедленное завершение на Windows обрезает
// асинхронный вывод.
main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(e => {
    console.error(`${PREFIX} сбой обёртки: ${e.message}`);
    process.exitCode = HARNESS_FAILURE;
  });
