/**
 * Окружение смоука — до загрузки конфига бандла: `helpers/config.ts` читает переменные
 * при импорте. Все `MONITOR_*` из оболочки убираются: оставшийся `MONITOR_CONFIG`,
 * `MONITOR_ARTIFACTS` или `MONITOR_CSV` направил бы фиктивные замеры в рабочую историю,
 * а `MONITOR_TARGET`, `MONITOR_RECHECK_OF` и прочие сломали бы сам смоук. Затем
 * выставляются свои значения. `process.env` на Windows сравнивает имена без учёта регистра.
 */
import * as path from 'path';

// Не в воркере: конфиг перезагружается и там, а воркер наследует MONITOR_RUN_ID от
// globalSetup — чистка стёрла бы его. Свои значения выставляются всегда.
if (process.env.TEST_WORKER_INDEX === undefined) {
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith('MONITOR_')) {
      delete process.env[name];
    }
  }
}
process.env.MONITOR_CONFIG = path.join(__dirname, 'env.smoke.json');
process.env.MONITOR_ARTIFACTS = path.join('artifacts', '_dev', 'smoke');
