/** Число воркеров из `MONITOR_WORKERS`. Без побочных эффектов: число процессоров — параметром. */

/** Половина логических процессоров, не меньше 1: больше браузеров искажают замеры самой машины. */
export function maxMonitorWorkers(cpuCount: number): number {
  return Math.max(1, Math.floor(cpuCount / 2));
}

export interface MonitorWorkers {
  /** Фактическое число воркеров — то, что уходит в `defineConfig({ workers })`. */
  workers: number;
  /** Текст предупреждения об урезании или `null`, если запрошенное значение в пределах. */
  warning: string | null;
}

/**
 * Пусто — 1; целое ≥ 1; `N%` (1–100) — доля всех логических процессоров, округление как у
 * Playwright для `workers: 'N%'`. Иное — исключение. Выше предела — урезается до
 * `maxMonitorWorkers` с `warning`. CLI `--workers` перекрывает результат, предел на него не
 * действует.
 */
export function resolveMonitorWorkers(raw: string | undefined, cpuCount: number): MonitorWorkers {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    return { workers: 1, warning: null };
  }

  const max = maxMonitorWorkers(cpuCount);
  let requested: number;

  if (/^\d+%$/.test(trimmed)) {
    const percent = Number(trimmed.slice(0, -1));
    if (percent < 1 || percent > 100) {
      throw new Error(unrecognizedMessage(trimmed));
    }
    requested = Math.max(1, Math.floor(cpuCount * (percent / 100)));
  } else if (/^\d+$/.test(trimmed)) {
    const count = Number(trimmed);
    if (count < 1) {
      throw new Error(unrecognizedMessage(trimmed));
    }
    requested = count;
  } else {
    throw new Error(unrecognizedMessage(trimmed));
  }

  if (requested > max) {
    return {
      workers: max,
      warning: `MONITOR_WORKERS=${trimmed} урезано до ${max} (логических процессоров: ${cpuCount})`
    };
  }
  return { workers: requested, warning: null };
}

function unrecognizedMessage(raw: string): string {
  return (
    `MONITOR_WORKERS="${raw}" не распознан. Допустимые формы: целое ≥ 1 (например 4) или ` +
    `процент ядер 1–100% (например 50%); по умолчанию — 1.`
  );
}
