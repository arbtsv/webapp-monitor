@echo off
rem Thin shim over the Node orchestrator: console codepage, local Node first in PATH,
rem delegation to scripts\monitor.mjs, pause when launched from Explorer.
rem
rem   monitor.bat [config] [NAME=VALUE ...]
rem
rem Exit code is the orchestrator's: 0 - ok, 1 - failed, 3 - run install.bat first.
rem
rem THIS FILE MUST STAY PURE ASCII: after `chcp 65001` cmd.exe loses the parse offset
rem of a batch file that contains non-ASCII bytes (Cyrillic comments or messages), and
rem the rest of the file parses as garbage. That hits scheduled/spawned runs (piped
rem console, OEM codepage at start). All logic and messages live in the orchestrator.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "SELF_NAME=%~nx0"

rem Console - UTF-8, like the scripts' output. "<nul": chcp.exe reads stdin.
chcp 65001 <nul >nul

rem Local node\ goes first in PATH; the system Node is never used.
if exist "%CD%\node\node.exe" set "PATH=%CD%\node;%PATH%"

rem Double click runs cmd.exe /c ""...\monitor.bat" " - script name in cmdcmdline and a
rem trailing space. An open console has no name, PowerShell and drag-and-drop don't.
set "FROM_EXPLORER="
set "CMDLINE=%cmdcmdline:"=%"
if /i not "!CMDLINE:%SELF_NAME%=!"=="!CMDLINE!" if "!CMDLINE:~-1!"==" " set "FROM_EXPLORER=1"

where node >nul 2>nul
if errorlevel 1 (
  echo [monitor] Node.js not found in %CD%\node or PATH.
  echo [monitor] Run install.bat in this folder first.
  set "MON_RC=3"
  goto finish
)

rem All arguments pass through whole: a quoted NAME=VALUE arrives as one token.
node scripts\monitor.mjs %*
set "MON_RC=%ERRORLEVEL%"

:finish
if defined FROM_EXPLORER pause
exit /b %MON_RC%
