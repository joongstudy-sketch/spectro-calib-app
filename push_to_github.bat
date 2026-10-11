@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  CHI CAN SUA DONG DUOI DAY CHO MOI DU AN MOI
REM ============================================================
set "REPO_URL=https://github.com/joongstudy-sketch/spectro-calib-app.git"
REM ============================================================

set "BRANCH=main"
set "COMMIT_MSG=Update project"
REM File lon hon so byte nay se tu dong bi bo qua. GitHub gioi han 100 MB
set "MAX_BYTES=100000000"

echo.
echo === DAY DU AN LEN GITHUB ===
echo Thu muc : %CD%
echo Repo    : %REPO_URL%
echo.

REM --- Kiem tra git ---
where git >nul 2>nul
if errorlevel 1 (
    echo [LOI] Chua cai Git. Tai tai: https://git-scm.com
    pause
    exit /b 1
)

REM --- Kiem tra da sua REPO_URL chua ---
if "%REPO_URL%"=="https://github.com/TEN_USER/TEN_REPO.git" (
    echo [LOI] Ban chua sua REPO_URL trong file .bat
    pause
    exit /b 1
)

REM --- Tao .gitignore neu chua co, chi bo node_modules ---
if not exist ".gitignore" (
    echo Tao .gitignore moi...
    > ".gitignore" echo node_modules/
) else (
    findstr /i /c:"node_modules" ".gitignore" >nul
    if errorlevel 1 (
        echo.>> ".gitignore"
        >> ".gitignore" echo node_modules/
    )
)

REM --- Khoi tao git neu chua co ---
if not exist ".git" (
    git init
    if errorlevel 1 goto :error
)

REM --- Go node_modules khoi git neu truoc do lo bi add ---
git rm -r --cached node_modules >nul 2>nul

REM --- Tu dong bo qua file qua lon ---
git config core.quotepath false
if not exist ".git\info" mkdir ".git\info"
for /f "delims=" %%f in ('git ls-files -c -o --exclude-standard') do call :checkfile "%%f"

REM --- Add + commit ---
git add -A
if errorlevel 1 goto :error

git diff --cached --quiet
if errorlevel 1 (
    git commit -m "%COMMIT_MSG%"
    if errorlevel 1 goto :error
) else (
    echo Khong co thay doi moi de commit.
)

REM --- Dat ten nhanh ---
git branch -M %BRANCH%

REM --- Cai dat remote origin ---
git remote get-url origin >nul 2>nul
if errorlevel 1 (
    git remote add origin "%REPO_URL%"
) else (
    git remote set-url origin "%REPO_URL%"
)

REM --- Push ---
git push -u origin %BRANCH%
if errorlevel 1 goto :pushfail

echo.
echo [OK] Da day len GitHub thanh cong!
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
echo [LOI] Push that bai. Nguyen nhan thuong gap:
echo   - Repo chua duoc tao tren GitHub, hay tao repo rong truoc
echo   - Repo tren GitHub da co noi dung khac, can pull truoc:
echo       git pull origin %BRANCH% --allow-unrelated-histories
echo   - Chua dang nhap GitHub, dung Git Credential Manager hoac token
pause
exit /b 1

:error
echo.
echo [LOI] Co loi xay ra, xem thong bao phia tren.
pause
exit /b 1
