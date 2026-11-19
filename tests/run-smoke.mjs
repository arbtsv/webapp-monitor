/**
 * Обёртка смоука: конвейер замеров и `report.mjs` без браузерной навигации, с проверкой
 * ожидаемого исхода вместо ручного разбора кода возврата.
 *
 * Два шага:
 *   1. `playwright test --config ./tests/smoke.config.ts` — ровно код 1: узлы `srv10` и `srv2`
 *      в `env.smoke.json` падают по замыслу, так что смоук не может пройти кодом 0.
 *   2. `scripts/report.mjs` по `artifacts/_dev/smoke` — код 0 и строка `ИТОГ: ПРОВАЛ`. Код 0, а
 *      не 1: `report.mjs` выходит кодом 1 только при собственном сбое (нет файла id прогона,
 *      не собрался архив), вердикт на код не влияет. Поэтому код 0 вместе со строкой
 *      `ИТОГ: ПРОВАЛ` отличает штатный провал набора от поломки отчёта.
 * Перед шагом 1 удаляется `last-run-id.txt` смоука: иначе шаг 1, упавший до замеров тем же
 * кодом 1 (нет `node_modules`, не загрузился конфиг), оставил бы шагу 2 id прошлого прогона,
 * и отчёт честно напечатал бы `ИТОГ: ПРОВАЛ` по старым данным. Файл обёртка не читает.
 *
 * Запуск: `npm run test:smoke` или `node ./tests/run-smoke.mjs` из каталога бандла.
 * Коды возврата: 0 — исход ожидаемый, 1 — неожиданный (причина — строкой `[run-smoke] …`),
 * 2 — сбой самой обёртки (нет `node_modules` бандла, дочерний процесс не запустился).
 * Вывод шагов идёт на консоль как есть.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  BUNDLE_ROOT,
  FAIL_VERDICT,
  HARNESS_FAILURE,
  envWithoutMonitor,
  runStep,
} from './run-lib.mjs';

const PREFIX = '[run-smoke]';

/** Каталог артефактов смоука — тот же, что выставляет `smoke-env.ts`; `common.mjs` резолвит его от корня бандла. */
const SMOKE_ARTIFACTS = path.join('artifacts', '_dev', 'smoke');

async function main() {
  const cli = path.join(BUNDLE_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!fs.existsSync(cli)) {
    console.error(`${PREFIX} нет ${cli} — сначала install.bat бандла`);
    return HARNESS_FAILURE;
  }

  fs.rmSync(path.join(BUNDLE_ROOT, SMOKE_ARTIFACTS, 'last-run-id.txt'), { force: true });

  const smoke = await runStep(
    PREFIX,
    'шаг 1 (playwright test)',
    [cli, 'test', '--config', './tests/smoke.config.ts'],
    envWithoutMonitor(),
    { code: 1 }
  );
  if (smoke !== 0) {
    return smoke;
  }

  // Только MONITOR_ARTIFACTS: MONITOR_CONFIG или MONITOR_CSV оболочки исказили бы отчёт.
  const reportEnv = envWithoutMonitor();
  reportEnv.MONITOR_ARTIFACTS = SMOKE_ARTIFACTS;
  return runStep(
    PREFIX,
    'шаг 2 (report.mjs)',
    [path.join(BUNDLE_ROOT, 'scripts', 'report.mjs')],
    reportEnv,
    { code: 0, marker: FAIL_VERDICT }
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
