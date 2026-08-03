@echo off
REM Double-click this file to start the Sanford Homeschoolers Check-In/Out system.
REM The first time you run it, it may take a minute while it sets everything up.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js isn't installed yet.
  echo Go to https://nodejs.org, download the LTS installer, run it, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Setting up for the first time, this can take a minute...
  call npm install
)

if not exist .env (
  copy .env.example .env >nul
  echo Created a .env settings file with default values.
  echo You can open it in a text editor later to set a real admin password.
)

set "PORT_TO_OPEN=3000"
for /f "usebackq tokens=1,2 delims==" %%A in (".env") do (
  if /i "%%A"=="PORT" set "PORT_TO_OPEN=%%B"
)

echo.
echo Starting the Check-In/Out system...
echo Your browser will open automatically in a couple of seconds.
echo.
echo IMPORTANT: keep this window open while you're using the system.
echo Closing it stops the server.
echo.

start "" cmd /c "timeout /t 2 >nul && start http://localhost:%PORT_TO_OPEN%"

call npm start

echo.
if errorlevel 1 (
  echo The server stopped because of an error - see the messages above for what went wrong.
) else (
  echo The server has stopped.
)
pause
