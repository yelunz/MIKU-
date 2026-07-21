@echo off
REM 同步 prototype/web-workbench/ 到 prototype/desktop-shell/web-workbench/
REM
REM 背景：electron-builder 不跟随 junction/symlink，必须用普通目录。
REM .gitignore 已忽略 prototype/desktop-shell/web-workbench/，所以这是
REM 本地构建时的临时副本，每次打包前运行此脚本同步最新源文件。
REM
REM 用法：在仓库根目录执行 scripts\sync-web-workbench.bat

setlocal
set "ROOT=%~dp0.."
set "SRC=%ROOT%\prototype\web-workbench"
set "DST=%ROOT%\prototype\desktop-shell\web-workbench"

if not exist "%SRC%" (
  echo [sync-web-workbench] ERROR: source not found: %SRC%
  exit /b 1
)

if exist "%DST%" (
  rmdir /s /q "%DST%" 2>nul
  if exist "%DST%" (
    REM junction 删除失败时尝试 rmdir /s
    rmdir /s "%DST%" 2>nul
  )
)

xcopy "%SRC%\*" "%DST%\" /e /i /y /q
if errorlevel 1 (
  echo [sync-web-workbench] ERROR: xcopy failed
  exit /b 1
)

echo [sync-web-workbench] OK: synced %SRC% -^> %DST%
dir /b "%DST%" | find /c /v "" | findstr "^" > "%TEMP%\miku_sync_count.txt"
set /p FILECOUNT=<"%TEMP%\miku_sync_count.txt"
echo [sync-web-workbench] %FILECOUNT% entries synced
endlocal
