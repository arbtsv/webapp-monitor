@echo off
rem Чистка архивов отчётов report_<run_id>.zip: спрашивает, за сколько дней их оставить.
rem
rem   prune-reports.bat                    спросить срок и подтверждение
rem   prune-reports.bat --days 30 --yes    без вопросов
rem
rem Пауза в конце - только при запуске без аргументов (двойной клик). Node.js не найден - код 3.
setlocal EnableExtensions DisableDelayedExpansion
set "WITH_ARGS="
if not "%~1"=="" set "WITH_ARGS=1"
cd /d "%~dp0"
if exist "%CD%\node\node.exe" set "PATH=%CD%\node;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [prune-reports.bat] Node.js не найден ни в "%CD%\node", ни в PATH - сначала install.bat.
  set "RC=3"
  goto finish
)
chcp 65001 >nul
node scripts\prune-reports.mjs %*
set "RC=%ERRORLEVEL%"
:finish
if not defined WITH_ARGS pause
exit /b %RC%
