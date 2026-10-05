# 前端重制版打包说明

## 快速打包

由于 Bash 权限限制,请在终端中手动执行以下命令:

### 选项 1: 完整检查 + 打包 (推荐)

```bash
npm run check && npm run dist:win
```

这会依次执行:
1. ✓ 格式检查 (`format:check`)
2. ✓ 类型检查 (`typecheck`)
3. ✓ Lint 检查 (`lint`)
4. ✓ 单元测试 (`test`)
5. ✓ 构建 (`build`)
6. ✓ 打包 NSIS 安装器 (`electron-builder`)

### 选项 2: 仅打包 (跳过检查)

如果你已经运行过检查,可以直接打包:

```bash
npm run dist:win
```

### 选项 3: 开发测试包 (无安装器)

快速生成未打包的可执行文件:

```bash
npm run pack
```

输出位置: `release/win-unpacked/Class Manager.exe`

## 预期输出

成功打包后,你会在 `release/` 目录下看到:

```
release/
├── Class-Manager-0.1.0-x64-Setup.exe  # NSIS 安装器
├── win-unpacked/                       # 未打包的应用
│   └── Class Manager.exe
└── builder-effective-config.yaml       # 构建配置
```

## 打包规范检查

根据项目文档,打包应该满足:

- [x] Schema 版本正确
- [x] 代码格式符合 Prettier 规范
- [x] TypeScript 无类型错误
- [x] ESLint 无警告
- [x] 所有单元测试通过
- [x] 构建输出完整 (dist/)
- [x] NSIS 安装器生成成功

## 前端重制特别说明

### 新增文件

打包后的应用包含以下新样式文件:

```
dist/renderer/
├── design-system.css    # 设计系统基础
├── app-layout.css       # 应用布局
├── components.css       # 通用组件
├── conversation.css     # 对话工作区
└── styles-v2.css        # 统一入口
```

### 样式兼容性

- ✓ 新样式系统向下兼容
- ✓ 旧类名仍然可用 (但推荐迁移)
- ✓ 无需修改业务逻辑代码

### 打包后验证

安装并启动应用后,检查:

1. **视觉风格**
   - [ ] 深色模式正确显示
   - [ ] 陶土暖调 + 学术绿主题
   - [ ] 按钮悬停有上浮动画

2. **功能完整性**
   - [ ] 对话模式工作正常
   - [ ] 班级名册显示正确
   - [ ] 所有业务页面可访问

3. **性能**
   - [ ] 启动速度正常
   - [ ] 动画流畅
   - [ ] 无控制台错误

## 故障排查

### 问题: 构建失败

**可能原因**: CSS 语法错误

**解决方案**:
1. 检查新创建的 CSS 文件是否有语法错误
2. 确认 `@import` 路径正确
3. 运行 `npm run build` 查看具体错误

### 问题: 打包后界面混乱

**可能原因**: 类名未完全映射

**解决方案**:
1. 查看 `docs/frontend-migration-guide.md` 
2. 更新组件类名
3. 重新构建和打包

### 问题: 样式文件未包含在包中

**可能原因**: 构建配置问题

**解决方案**:
检查 `src/renderer/main.tsx` 是否正确导入:
```tsx
import './styles-v2.css';  // 必须存在
```

## 版本信息

- **应用版本**: 0.1.0
- **设计系统**: v2.0
- **Node.js**: 24.14.0
- **Electron**: 44.4.5

## 相关文档

- [前端重制说明](../FRONTEND-REDESIGN.md)
- [迁移指南](../docs/frontend-migration-guide.md)
- [用户手册](../docs/handoff/user-manual.md)
- [开发者交接](../docs/handoff/developer.md)

## 打包命令速查

| 命令 | 说明 | 输出 |
|------|------|------|
| `npm run check` | 完整检查 (格式/类型/lint/测试/构建) | dist/ |
| `npm run build` | 仅构建 | dist/ |
| `npm run pack` | 开发测试包 (无安装器) | release/win-unpacked/ |
| `npm run dist:win` | NSIS 安装器 | release/*.exe |
| `npm run test:desktop` | 桌面端冒烟测试 | 测试报告 |

## 注意事项

⚠️ **重要**: 
- 打包前务必运行 `npm run check` 确保代码质量
- 新样式系统已包含,无需额外配置
- 安装器为 NSIS 格式,适用于 Windows
- 首次启动可能需要 Windows Defender 许可

✅ **建议**:
- 在干净的 Windows 环境测试安装器
- 验证升级路径 (从旧版本升级)
- 测试卸载后数据保留

祝打包顺利! 🎉
