@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

REM ============================================================================
REM  NetLOL v5 — Production-ready launcher for Windows
REM
REM  NO AUTO-SEED. This script:
REM    1. Auto-detects Bun or Node.js
REM    2. Force-writes .env with correct config
REM    3. Installs dependencies (first run only)
REM    4. Generates Prisma client + pushes schema
REM    5. Starts the dev server
REM
REM  To create demo data:  bun scripts/seed-demo.ts
REM  To create an admin:   bun scripts/create-admin.ts
REM ============================================================================

echo.
echo   ================================================
echo    NetLOL v5  -  Production mode
echo   ================================================
echo.

REM ── Step 1: Detect runtime ──────────────────────────────────────
set "RUNTIME="
where bun >nul 2>nul
if !errorlevel! equ 0 (
    set "RUNTIME=bun"
    echo   [1^/5] Runtime: Bun
) else (
    where node >nul 2>nul
    if !errorlevel! equ 0 (
        set "RUNTIME=npm"
        for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
        echo   [1^/5] Runtime: Node.js !NODE_VER!
    ) else (
        echo   [ERROR] Install Node.js from https://nodejs.org/
        pause
        exit /b 1
    )
)

REM ── Step 2: Write .env ──────────────────────────────────────────
echo.
echo   [2^/5] Writing .env...
> .env echo DATABASE_URL=file:../db/dev.db
>> .env echo DATABASE_PROVIDER=sqlite
>> .env echo BYOK_ENCRYPTION_SECRET=dev-only-secret-change-in-production-32chars
>> .env echo NEXT_PUBLIC_API_URL=
>> .env echo CORS_ORIGINS=http://localhost:3000
>> .env echo NODE_ENV=development
set "DATABASE_URL=file:../db/dev.db"
set "DATABASE_PROVIDER=sqlite"
if not exist "db" mkdir db 2>nul
echo         .env OK

REM ── Step 3: Install deps ────────────────────────────────────────
if not exist "node_modules" (
    echo.
    echo   [3^/5] Installing dependencies ^(2-5 min^)...
    if "!RUNTIME!"=="bun" ( bun install ) else ( npm install --no-audit --no-fund )
    if !errorlevel! neq 0 (
        echo   [ERROR] Install failed.
        pause
        exit /b 1
    )
) else (
    echo   [3^/5] Dependencies OK.
)

REM ── Step 4: Prisma ─────────────────────────────────────────────
echo.
echo   [4^/5] Setting up database...
set "PRISMA_BIN="
if exist "node_modules\.bin\prisma.cmd" (
    set "PRISMA_BIN=node_modules\.bin\prisma.cmd"
) else if exist "node_modules\.bin\prisma" (
    set "PRISMA_BIN=node_modules\.bin\prisma"
)
if "!PRISMA_BIN!"=="" (
    echo   [ERROR] Prisma not found.
    pause
    exit /b 1
)
call !PRISMA_BIN! generate
if exist "db\dev.db" del /f /q "db\dev.db" 2>nul
call !PRISMA_BIN! db push --accept-data-loss
echo         Database ready.

REM ── Step 5: Start server ───────────────────────────────────────
echo.
echo   [5^/5] Starting NetLOL...
echo.
echo        URL:   http://localhost:3000
echo.
echo        No demo data seeded. To create data:
echo          bun scripts/seed-demo.ts      ^(demo content^)
echo          bun scripts/create-admin.ts   ^(hidden admin^)
echo.
echo        Or sign up at http://localhost:3000
echo.
echo        Press Ctrl+C to stop.
echo        ================================================
echo.

start /min cmd /c "ping -n 11 127.0.0.1 >nul 2>&1 & start "" http://localhost:3000"

if "!RUNTIME!"=="bun" (
    bunx next dev -p 3000
) else (
    if exist "node_modules\.bin\next.cmd" (
        call node_modules\.bin\next.cmd dev -p 3000
    ) else (
        npx --yes next dev -p 3000
    )
)

echo.
echo  Server stopped.
pause >nul
endlocal
