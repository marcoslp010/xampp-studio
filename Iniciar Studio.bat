@echo off
setlocal EnableExtensions DisableDelayedExpansion
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "studioExit=%ERRORLEVEL%"
if not "%studioExit%"=="0" (
    echo(
    echo O XAMPP Studio encerrou com erro. Confira a mensagem acima.
    pause
)
exit /b %studioExit%
