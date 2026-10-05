@echo off
setlocal EnableExtensions DisableDelayedExpansion
if not defined LOCALAPPDATA goto noLocalData
set "SOURCE=%~dp0__INSTALLER_FILENAME__"
if not exist "%SOURCE%" goto noInstaller
set "STAGE=%LOCALAPPDATA%\ClassManagerSetup\run-%RANDOM%-%RANDOM%"
if exist "%STAGE%\" goto stageFailed
mkdir "%STAGE%\temp" 2>nul
if errorlevel 1 goto stageFailed
set "TEMP=%STAGE%\temp"
set "TMP=%TEMP%"
echo probe>"%TEMP%\write-check.txt"
if errorlevel 1 goto stageFailed
copy /b "%SOURCE%" "%STAGE%\Setup.exe" >nul
if errorlevel 1 goto copyFailed
fc /b "%SOURCE%" "%STAGE%\Setup.exe" >nul
if errorlevel 1 goto copyFailed
echo Installer copy verified.
echo Temporary directory: "%TEMP%"
if /I "%~1"=="--check" exit /b 0
echo Starting the installation wizard. Choose a folder on drive C.
start "" /wait "%STAGE%\Setup.exe"
set "RESULT=%ERRORLEVEL%"
echo Installer exit code: %RESULT%
if not "%RESULT%"=="0" pause
exit /b %RESULT%

:noLocalData
echo ERROR: LOCALAPPDATA is not defined.
goto failed
:noInstaller
echo ERROR: Keep Install.cmd beside "__INSTALLER_FILENAME__".
goto failed
:stageFailed
echo ERROR: Cannot create or write the isolated temporary directory.
goto failed
:copyFailed
echo ERROR: The installer could not be copied or verified.
:failed
if /I "%~1"=="--check" exit /b 1
pause
exit /b 1
