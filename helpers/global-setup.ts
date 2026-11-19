import type { FullConfig } from '@playwright/test/reporter';
import { ensureCsvHeader, generateRunId, writeRunIdFile } from './metrics';
import { RECHECK_OF } from './config';

/**
 * Один раз до старта воркеров. Модуль спеки грузится в каждом воркере заново, поэтому общий
 * run_id создаётся здесь: воркерам — через `MONITOR_RUN_ID`, JSON-отчёту — через
 * `config.metadata`, `scripts/report.mjs` — через `last-run-id.txt`. У перепроверки id —
 * `<RECHECK_OF>-recheck`, по нему отчёт ищет её строки; `last-run-id.txt` она не трогает.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const requested = process.env.MONITOR_RUN_ID?.trim();
  let id: string;
  if (RECHECK_OF) {
    const expected = `${RECHECK_OF}-recheck`;
    if (requested && requested !== expected) {
      throw new Error(
        `MONITOR_RUN_ID="${requested}" не согласован с MONITOR_RECHECK_OF="${RECHECK_OF}": ожидался ` +
          `"${expected}". Раздел «Перепроверка» отчёта ищет в CSV строки именно с этим id — несогласованный ` +
          'id сделал бы их ненаходимыми.'
      );
    }
    id = requested || expected;
  } else {
    id = requested || generateRunId();
  }
  process.env.MONITOR_RUN_ID = id;
  config.metadata = { ...config.metadata, run_id: id };
  // Шапка metrics.csv — до файла id: при её сбое monitor.bat считает, что прогон не начался.
  ensureCsvHeader();
  if (!RECHECK_OF) {
    writeRunIdFile(id);
  }
}
