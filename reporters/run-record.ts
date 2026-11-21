/**
 * Пишет строку `runs.csv` в `onBegin`: список узлов уже отфильтрован по `--project`,
 * run_id задан globalSetup. Сбой записи — только предупреждение.
 */
import type { FullConfig, Reporter, Suite } from '@playwright/test/reporter';
import { recordRun } from '../helpers/runs';

export default class RunRecordReporter implements Reporter {
  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    const runId = process.env.MONITOR_RUN_ID?.trim();
    if (!runId) {
      return;
    }
    const targets = suite.suites.map(s => s.project()?.name ?? '').filter(Boolean);
    try {
      recordRun(config, runId, targets);
    } catch (e) {
      console.warn(`[webapp-monitor] runs.csv не записан: ${(e as Error).message}`);
    }
  }
}
