@echo off
REM 班级管理系统手动测试启动脚本
REM 使用独立测试数据目录，不影响生产数据

echo ============================================
echo 班级管理系统手动功能测试
echo ============================================
echo.
echo 测试版本: 18号审查候选 (Agent-Sessions)
echo 测试日期: 2026-10-05
echo 测试方式: 实际用户操作
echo.
echo 正在启动应用...
echo.

REM 使用独立测试环境
cd /d "H:\WorkSpace\class-manager\output\release-audit18-reviewed\win-unpacked"
start "" "Class Manager.exe"

echo.
echo 应用已启动！
echo.
echo 请按照以下文档进行测试：
echo   - manual-test-plan.md (详细测试清单)
echo   - MANUAL_TEST_EXECUTION_GUIDE.md (执行指南)
echo.
echo 测试要点：
echo   1. 等待右上角显示"本地就绪"
echo   2. 确认默认进入"业务对话"页面
echo   3. 首先点击"载入合成样例"创建测试数据
echo   4. 在"模型设置"配置API Key（如需测试AI功能）
echo   5. 按测试清单逐项操作验证
echo.
echo 注意事项：
echo   - 使用独立测试数据目录
echo   - 不会影响任何生产数据
echo   - 可以多次重置重新测试
echo.
pause
