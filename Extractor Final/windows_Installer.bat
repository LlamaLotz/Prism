@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo ====================================================
echo PRISM EXTRACTOR INSTALLER - WINDOWS
echo ====================================================

echo.
echo ====================================================
echo Checking Python 3.12...
echo ====================================================

set "PYCMD="

:: Prefer the Python launcher because it selects the requested minor version
:: even when another Python version appears first on PATH.
where py >nul 2>nul
if not errorlevel 1 (
    py -3.12 --version >nul 2>&1
    if not errorlevel 1 set "PYCMD=py -3.12"
)

:: Otherwise accept a PATH python only when it is exactly Python 3.12.
if not defined PYCMD (
    where python >nul 2>nul
    if not errorlevel 1 (
        for /f "tokens=2" %%v in ('python --version 2^>^&1') do set "PY_VER=%%v"
        echo Detected Python version: !PY_VER!
        echo !PY_VER! | findstr /R "^3\.12\." >nul
        if not errorlevel 1 set "PYCMD=python"
    )
)

if not defined PYCMD (
    echo Python 3.12 was not found. Installing it through WinGet...
    where winget >nul 2>nul
    if errorlevel 1 (
        echo ERROR: WinGet is not available on this Windows installation.
        echo Install App Installer from the Microsoft Store, then run this installer again.
        exit /b 1
    )

    winget install --id Python.Python.3.12 -e --source winget --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo ERROR: WinGet could not install Python 3.12.
        exit /b 1
    )

    :: Refresh this process PATH. WinGet may install either the launcher or the
    :: per-user Python directory, depending on the machine's configuration.
    set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%ProgramFiles%\Python312;%ProgramFiles%\Python312\Scripts;%LOCALAPPDATA%\Microsoft\WindowsApps;%PATH%"

    where py >nul 2>nul
    if not errorlevel 1 (
        py -3.12 --version >nul 2>&1
        if not errorlevel 1 set "PYCMD=py -3.12"
    )

    if not defined PYCMD (
        where python >nul 2>nul
        if not errorlevel 1 (
            for /f "tokens=2" %%v in ('python --version 2^>^&1') do set "PY_VER=%%v"
            echo !PY_VER! | findstr /R "^3\.12\." >nul
            if not errorlevel 1 set "PYCMD=python"
        )
    )
)

if not defined PYCMD (
    echo ERROR: Python 3.12 was installed but could not be found in this session.
    echo Close and reopen the installer or Command Prompt, then try again.
    exit /b 1
)

for /f "tokens=2" %%v in ('%PYCMD% --version 2^>^&1') do set "PY_VER=%%v"
echo Using Python !PY_VER! via %PYCMD%
echo.
echo ====================================================
echo Installing System Dependencies (FFmpeg Essentials)...
echo ====================================================

winget install --id Gyan.FFmpeg.Shared -e --source winget --accept-source-agreements --accept-package-agreements

:: Refresh environment PATH and locate FFmpeg from the WinGet package if needed.
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "SYS_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USER_PATH=%%B"
set "PATH=%SYS_PATH%;%USER_PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Links;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"

for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do (
    for /r "%%D" %%F in (ffmpeg.exe) do set "PATH=%%~dpF;!PATH!"
)

where ffmpeg >nul 2>nul
if not errorlevel 1 (
    echo [SUCCESS] FFmpeg bound successfully to the current installer session.
) else (
    echo [NOTICE] FFmpeg was installed but is not currently on PATH. Restart Windows if required.
)

echo.
echo ====================================================
echo Installing / Upgrading Python Packages...
echo ====================================================

%PYCMD% -m pip install --upgrade pip
if errorlevel 1 exit /b 1
%PYCMD% -m pip install --upgrade yt-dlp faster-whisper torch crawl4ai docling omniroute tqdm
if errorlevel 1 exit /b 1

echo.
echo ====================================================
echo Setting up Playwright Headless Browsers...
echo ====================================================

%PYCMD% -m playwright install chromium
if errorlevel 1 exit /b 1

echo.
echo ====================================================
echo Windows setup complete. The extractor will use Python 3.12 automatically.
echo ====================================================
pause
