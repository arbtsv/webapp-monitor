/**
 * Отключение QuickEdit у консоли прогона (Windows).
 *
 * conhost в режиме QuickEdit блокирует WriteConsole, пока выделение не снято: клик в окно
 * остановил бы и вывод, и сам прогон (раннер стоит в записи, воркеры — за забитым IPC,
 * глобальный таймаут может легитимно сработать). Поэтому при интерактивном запуске
 * монитор снимает ENABLE_QUICK_EDIT_MODE (0x40) с консольного входного буфера и держит
 * ENABLE_EXTENDED_FLAGS (0x80). Мышиное выделение недоступно; копирование — меню консоли
 * → Изменить → Пометить (Ctrl+M). Настройка живёт, пока открыто окно консоли.
 *
 * Реализация — один вызов powershell.exe с P/Invoke kernel32 (системный PowerShell есть
 * на любой поддерживаемой Windows; в каталог ничего не ставится). stdio — inherit:
 * тогда GetStdHandle(STD_INPUT_HANDLE) дочернего процесса — буфер консоли родителя.
 * Сбой отключения не роняет прогон: вызывающий печатает предупреждение и идёт дальше.
 */
import { spawnSync } from 'child_process';

// STD_INPUT_HANDLE = -10; ENABLE_QUICK_EDIT_MODE = 0x40, ENABLE_EXTENDED_FLAGS = 0x80.
const PS_SNIPPET =
  'Add-Type -Name Q -Namespace M ' +
  "-MemberDefinition '" +
  '[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n); ' +
  '[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m); ' +
  '[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);' +
  "'; " +
  '$h = [M.Q]::GetStdHandle(-10); $m = [uint32]0; ' +
  'if ([M.Q]::GetConsoleMode($h, [ref]$m)) ' +
  '{ if (-not [M.Q]::SetConsoleMode($h, (($m -band (-bnot [uint32]0x40)) -bor [uint32]0x80))) { exit 1 } } ' +
  'else { exit 1 }';

/** Аргументы вызова PowerShell: отдельной функцией — юнит-тест сверяет состав. */
export function powershellQuickEditOffArgs() {
  return ['-NoProfile', '-NonInteractive', '-Command', PS_SNIPPET];
}

/**
 * Снять QuickEdit с текущей консоли. Результат — { ok, reason }: ok=false с читаемой
 * причиной никогда не бросает исключение наружу.
 */
export function disableQuickEdit(timeoutMs = 15000) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'не Windows' };
  }
  try {
    const run = spawnSync('powershell.exe', powershellQuickEditOffArgs(), {
      stdio: 'inherit',
      timeout: timeoutMs,
      windowsHide: true
    });
    if (run.error) {
      return { ok: false, reason: run.error.message };
    }
    if (run.status !== 0) {
      return { ok: false, reason: `powershell завершился кодом ${run.status}` };
    }
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
