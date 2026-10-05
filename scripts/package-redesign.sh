#!/bin/bash
# 前端重制后的打包脚本
# 按照项目规范执行完整检查和打包流程

set -e  # 遇到错误立即退出

echo "=========================================="
echo "班级管理客户端 - 前端重制版打包流程"
echo "=========================================="
echo ""

# 步骤 1: 格式检查
echo "▶ 步骤 1/6: 检查代码格式..."
npm run format:check
echo "✓ 代码格式检查通过"
echo ""

# 步骤 2: 类型检查
echo "▶ 步骤 2/6: TypeScript 类型检查..."
npm run typecheck
echo "✓ 类型检查通过"
echo ""

# 步骤 3: Lint 检查
echo "▶ 步骤 3/6: ESLint 代码质量检查..."
npm run lint
echo "✓ Lint 检查通过"
echo ""

# 步骤 4: 单元测试
echo "▶ 步骤 4/6: 运行单元测试..."
npm test
echo "✓ 单元测试通过"
echo ""

# 步骤 5: 构建
echo "▶ 步骤 5/6: 构建应用..."
npm run build
echo "✓ 构建完成"
echo ""

# 步骤 6: 打包 (NSIS 安装器)
echo "▶ 步骤 6/6: 生成 Windows 安装器..."
npx electron-builder --win nsis --x64
node scripts/prepare-windows-installer.mjs
echo "✓ 打包完成"
echo ""

echo "=========================================="
echo "✓ 打包流程全部完成!"
echo "=========================================="
echo ""
echo "输出位置: release/"
echo "安装器: release/Class-Manager-0.1.0-x64-Setup.exe"
echo ""
echo "前端重制说明: 查看 FRONTEND-REDESIGN.md"
echo "迁移指南: 查看 docs/frontend-migration-guide.md"
