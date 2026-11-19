@echo off
rem Thin ASCII shim over the Node orchestrator, like monitor.bat: console codepage,
rem bootstrap of local Node.js when absent, delegation to scripts\install.mjs,
rem pause when launched from Explorer. All logic and Russian
rem messages live in the orchestrator; this file MUST stay pure ASCII - after
rem `chcp 65001` cmd.exe loses the parse offset of a batch file containing
rem non-ASCII bytes and executes garbage on scheduled/spawned runs.
rem
rem   install.bat [/y] [/reinstall] [/?]
rem
rem Exit code is the orchestrator's: 0 - done; 1 - step failure; 2 - no consent,
rem unknown key, help. Node.js version pinned below is downloaded by the
rem bootstrap when node\ is absent; the orchestrator re-checks it.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "SELF_NAME=%~nx0"
set "NODE_VERSION=24.21.0"

rem Console - UTF-8, like the orchestrator's output. "<nul": chcp.exe reads stdin.
for /f "tokens=2 delims=:" %%a in ('chcp ^<nul') do set "OLD_CP=%%a"
chcp 65001 <nul >nul

rem Double click runs cmd.exe /c ""...\install.bat" " - script name in cmdcmdline
rem and a trailing space. An open console has no name; scheduler/spawn don't.
set "FROM_EXPLORER="
set "CMDLINE=%cmdcmdline:"=%"
if /i not "!CMDLINE:%SELF_NAME%=!"=="!CMDLINE!" if "!CMDLINE:~-1!"==" " set "FROM_EXPLORER=1"

rem --- Bootstrap: local Node is mandatory, the system one is never used.
rem Until node\node.exe exists nobody else can run the download, so
rem this preamble stays in cmd - pure ASCII, external tools only (curl, certutil,
rem tar from System32). Everything after lives in scripts\install.mjs.
if not exist "node\node.exe" (
  call :bootstrap_node
  if errorlevel 1 (
    set "MON_RC=1"
    goto finish
  )
)
set "PATH=%CD%\node;%PATH%"

node scripts\install.mjs %*
set "MON_RC=%ERRORLEVEL%"

:finish
if defined FROM_EXPLORER pause
if defined OLD_CP chcp %OLD_CP% <nul >nul
endlocal & exit /b %MON_RC%

rem --- Bootstrap preamble: download, verify (SHA-256) and unpack Node.js into
rem node\. Called only when node\node.exe is absent. ASCII output only; failure
rem prints a short English reason and exits 1 - the orchestrator's detailed
rem Russian diagnostics are unavailable before Node exists.
:bootstrap_node
set "NODE_BASE=https://nodejs.org/dist"
if defined MONITOR_NODE_MIRROR (
  set "NODE_BASE=%MONITOR_NODE_MIRROR%"
  if "!NODE_BASE:~-1!"=="/" set "NODE_BASE=!NODE_BASE:~0,-1!"
)
set "NODE_ARCHIVE=node-v%NODE_VERSION%-win-x64.zip"
if exist ".install-tmp\bootstrap" rd /s /q ".install-tmp\bootstrap" >nul 2>nul
md ".install-tmp\bootstrap\download" >nul 2>nul
echo [install] Downloading Node.js v%NODE_VERSION%...
rem SHASUMS is ~3 KB: quiet download, progress bar only on the Node archive below.
"%SystemRoot%\System32\curl.exe" -f -L --retry 2 -sS -o ".install-tmp\bootstrap\download\SHASUMS256.txt" "%NODE_BASE%/v%NODE_VERSION%/SHASUMS256.txt"
if errorlevel 1 (
  echo [install] Failed to download SHASUMS256.txt. Check the mirror: %NODE_BASE%
  exit /b 1
)
"%SystemRoot%\System32\curl.exe" -f -L --retry 2 --progress-bar -o ".install-tmp\bootstrap\download\%NODE_ARCHIVE%" "%NODE_BASE%/v%NODE_VERSION%/%NODE_ARCHIVE%"
if errorlevel 1 (
  echo [install] Failed to download %NODE_ARCHIVE%. Check the mirror: %NODE_BASE%
  exit /b 1
)
set "EXPECTED_SHA="
for /f "usebackq tokens=1,2" %%h in (".install-tmp\bootstrap\download\SHASUMS256.txt") do (
  if /i "%%i"=="%NODE_ARCHIVE%" set "EXPECTED_SHA=%%h"
)
if not defined EXPECTED_SHA (
  echo [install] No %NODE_ARCHIVE% entry in SHASUMS256.txt.
  exit /b 1
)
set "ACTUAL_SHA="
set "SHA_LINE_NO=0"
rem Outer quotes are required: cmd /c inside for /f would strip certutil.exe path quotes.
for /f "delims=" %%s in ('""%SystemRoot%\System32\certutil.exe" -hashfile ".install-tmp\bootstrap\download\%NODE_ARCHIVE%" SHA256"') do (
  set /a SHA_LINE_NO+=1
  if "!SHA_LINE_NO!"=="2" set "ACTUAL_SHA=%%s"
)
set "ACTUAL_SHA=!ACTUAL_SHA: =!"
if /i not "!ACTUAL_SHA!"=="!EXPECTED_SHA!" (
  echo [install] SHA-256 mismatch - archive is corrupt or tampered with.
  exit /b 1
)
md ".install-tmp\bootstrap\extract" >nul 2>nul
"%SystemRoot%\System32\tar.exe" -xf ".install-tmp\bootstrap\download\%NODE_ARCHIVE%" -C ".install-tmp\bootstrap\extract"
if errorlevel 1 (
  echo [install] Failed to unpack the Node.js archive.
  exit /b 1
)
if not exist ".install-tmp\bootstrap\extract\node-v%NODE_VERSION%-win-x64\node.exe" (
  echo [install] node.exe not found after unpacking.
  exit /b 1
)
move ".install-tmp\bootstrap\extract\node-v%NODE_VERSION%-win-x64" "node" >nul
if not exist "node\node.exe" (
  echo [install] Failed to move Node.js into node\.
  exit /b 1
)
rd /s /q ".install-tmp\bootstrap" >nul 2>nul
exit /b 0
