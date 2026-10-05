@echo off
REM 前端重制版打包脚本 (Windows Batch)
REM 按照项目规范执行完整检查和打包流程

echo ==========================================
echo 班级管理客户端 - 前端重制版打包流程
echo ==========================================
echo.

REM 步骤 1: 格式检查
echo [1/6] 检查代码格式...
call npm run format:check
if errorlevel 1 (
    echo [错误] 代码格式检查失败
    exit /b 1
)
echo [成功] 代码格式检查通过
echo.

REM 步骤 2: 类型检查
echo [2/6] TypeScript 类型检查...
call npm run typecheck
if errorlevel 1 (
    echo [错误] 类型检查失败
    exit /b 1
)
echo [成功] 类型检查通过
echo.

REM 步骤 3: Lint 检查
echo [3/6] ESLint 代码质量检查...
call npm run lint
if errorlevel 1 (
    echo [错误] Lint 检查失败
    exit /b 1
)
echo [成功] Lint 检查通过
echo.

REM 步骤 4: 单元测试
echo [4/6] 运行单元测试...
call npm test
if errorlevel 1 (
    echo [错误] 单元测试失败
    exit /b 1
)
echo [成功] 单元测试通过
echo.

REM 步骤 5: 构建
echo [5/6] 构建应用...
call npm run build
if errorlevel 1 (
    echo [错误] 构建失败
    exit /b 1
)
echo [成功] 构建完成
echo.

REM 步骤 6: 打包 (NSIS 安装器)
echo [6/6] 生成 Windows 安装器...
call npx electron-builder --win nsis --x64
if errorlevel 1 (
    echo [错误] 打包失败
    exit /b 1
)
call node scripts/prepare-windows-installer.mjs
if errorlevel 1 (
    echo [错误] 安装器准备失败
    exit /b 1
)
echo [成功] 打包完成
echo.

echo ==========================================
echo [完成] 打包流程全部完成!
echo ==========================================
echo.
echo 输出位置: release\
echo 安装器: release\Class-Manager-0.1.0-x64-Setup.exe
echo.
echo 前端重制说明: 查看 FRONTEND-REDESIGN.md
echo 迁移指南: 查看 docs\frontend-migration-guide.md
echo.
pause
