@echo off
setlocal
cd /d "%~dp0"

REM File lon hon so byte nay se tu dong bi bo qua. GitHub gioi han 100 MB
set "MAX_BYTES=100000000"

echo.
echo === COMMIT + PUSH CAP NHAT LEN GITHUB ===
echo Thu muc: %CD%
echo.

REM --- Kiem tra git va repo ---
where git >nul 2>nul
if errorlevel 1 (
    echo [LOI] Chua cai Git.
    pause
    exit /b 1
)

if not exist ".git" (
    echo [LOI] Thu muc nay chua phai repo Git.
    echo Hay chay push_to_github.bat de day lan dau truoc.
    pause
    exit /b 1
)

REM --- Lay ten nhanh hien tai ---
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"

REM --- Go node_modules khoi git neu lo bi add ---
git rm -r --cached node_modules >nul 2>nul

REM --- Tu dong bo qua file qua lon ---
git config core.quotepath false
if not exist ".git\info" mkdir ".git\info"
for /f "delims=" %%f in ('git ls-files -c -o --exclude-standard') do call :checkfile "%%f"

REM --- Hien thi thay doi ---
git add -A
echo Cac thay doi:
git status --short
echo.

git diff --cached --quiet
if not errorlevel 1 (
    echo Khong co thay doi nao de commit.
    pause
    exit /b 0
)

REM --- Nhap noi dung commit, de trong thi dung ngay gio ---
set "MSG="
set /p "MSG=Noi dung commit (Enter de dung mac dinh): "
if "%MSG%"=="" set "MSG=Update %date% %time:~0,5%"

git commit -m "%MSG%"
if errorlevel 1 goto :error

git push -u origin %BRANCH%
if errorlevel 1 goto :pushfail

echo.
echo [OK] Da commit va push len nhanh %BRANCH%.
pause
exit /b 0

:checkfile
if not exist "%~1" exit /b 0
if %~z1 LEQ %MAX_BYTES% exit /b 0
echo [BO QUA] File qua lon: %~1
>> ".git\info\exclude" echo /%~1
git rm --cached -q -- "%~1" >nul 2>nul
exit /b 0

:pushfail
echo.
echo [LOI] Push that bai. Thu kiem tra:
echo   - Ket noi mang va dang nhap GitHub
echo   - Remote co moi hon may nay, chay: git pull --rebase origin %BRANCH%
pause
exit /b 1

:error
echo.
echo [LOI] Commit that bai, xem thong bao phia tren.
pause
exit /b 1
