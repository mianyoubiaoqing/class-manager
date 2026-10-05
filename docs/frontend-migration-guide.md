# 前端重制迁移指南

## 概述

本指南帮助你将现有的班级管理客户端从旧样式系统迁移到新的 v2.0 设计系统。

## 已完成的工作

✅ 创建了完整的设计系统文件:
- `src/renderer/design-system.css` - 色彩、字体、token
- `src/renderer/app-layout.css` - 应用框架布局
- `src/renderer/components.css` - 通用组件
- `src/renderer/conversation.css` - 对话工作区
- `src/renderer/styles-v2.css` - 统一入口

✅ 更新了样式导入:
- `src/renderer/main.tsx` 已更新为导入 `styles-v2.css`

## 迁移步骤

### 步骤 1: 验证新样式加载

启动应用查看新设计系统是否生效:

```bash
npm run dev
```

你应该看到:
- **深色背景** (陶土暖调,不是纯黑)
- **绿色主题** (学术绿,不是蓝色)
- **温润的视觉风格**

如果界面看起来混乱,说明类名需要映射。

### 步骤 2: 更新 App.tsx 类名

#### 应用框架类名

保持不变的:
- `.app-shell`
- `.sidebar`
- `.topbar`
- `.main-content`

需要更新的:
```tsx
// 旧: className="content"
// 新: className="workspace"

// 旧: className="sidebar-collapsed"
// 新: 保持不变 (已支持)
```

#### 按钮类名映射

| 旧类名 | 新类名 | 说明 |
|--------|--------|------|
| `className="primary"` | `className="btn btn-primary"` | 主按钮 |
| `className="icon-button"` | `className="btn btn-icon"` | 图标按钮 |
| `className="icon-button outlined"` | `className="btn btn-icon btn-secondary"` | 带边框的图标按钮 |
| `className="danger"` | `className="btn btn-primary"` + 自定义颜色 | 危险操作 |

示例:
```tsx
// 旧写法
<button className="primary" onClick={handleSave}>
  <Plus size={16} />
  保存
</button>

// 新写法
<button className="btn btn-primary" onClick={handleSave}>
  <Plus size={16} />
  保存
</button>
```

#### 侧栏导航类名

| 旧类名 | 新类名 |
|--------|--------|
| `.brand` | `.sidebar-brand` |
| `.brand-mark` | `.brand-icon` |
| `.nav-item.selected` | `.nav-item.active` |
| `.class-navigation` | `.class-nav-section` |

#### 通知类名

| 旧类名 | 新类名 |
|--------|--------|
| `.notice.success` | `.notice.notice-success` |
| `.notice.error` | `.notice.notice-error` |

#### 指标卡片

| 旧类名 | 新类名 |
|--------|--------|
| `.metrics` | `.metrics-grid` |
| 内部结构 | 使用 `.metric-card` 包装 |

示例:
```tsx
// 旧写法
<section className="metrics">
  <div>
    <UsersRound size={20} />
    <span>在籍学生<strong>100<small>人</small></strong></span>
  </div>
</section>

// 新写法
<div className="metrics-grid">
  <div className="metric-card">
    <div className="metric-icon">
      <UsersRound size={24} />
    </div>
    <div className="metric-content">
      <div className="metric-label">在籍学生</div>
      <div className="metric-value">100<span className="metric-unit">人</span></div>
    </div>
  </div>
</div>
```

#### 表格类名

| 旧类名 | 新类名 |
|--------|--------|
| `.table-scroll` | `.table-container` |
| 内部保持 `.table-wrapper` 和 `.table` | 保持不变 |

#### 对话工作区

| 旧类名 | 新类名 |
|--------|--------|
| `.conversation-page` | `.conversation-workspace` |
| `.conversation-card` | `.task-card` (AI任务) |
| `.conversation-message.user` | `.message-bubble.user` |
| `.conversation-message.assistant` | `.message-bubble.assistant` |

### 步骤 3: 测试关键页面

按优先级测试以下页面:

1. **对话模式** (conversation)
   - [ ] 空状态显示正确
   - [ ] 启动器胶囊可点击
   - [ ] 消息气泡正确渲染
   - [ ] 任务卡片状态清晰
   - [ ] 输入框工作正常

2. **班级名册** (roster)
   - [ ] 指标卡片正确显示
   - [ ] 搜索框工作正常
   - [ ] 表格行悬停效果
   - [ ] 分页器功能正常

3. **成绩管理** (scores)
   - [ ] 成绩卡片布局
   - [ ] 表格数据对齐
   - [ ] 操作按钮可用

4. **座位编排** (seating)
   - [ ] 座位网格渲染
   - [ ] 拖放交互 (如果有)
   - [ ] 保存按钮状态

5. **维护页面** (maintenance)
   - [ ] 信息网格布局
   - [ ] 测试卡片显示
   - [ ] 账本统计正确

### 步骤 4: 响应式测试

在不同屏幕尺寸下测试:

- [ ] **1920x1080** (全高清桌面)
- [ ] **1366x768** (笔记本)
- [ ] **768x1024** (平板竖屏)
- [ ] **375x812** (手机)

重点检查:
- 侧栏是否正确收起/展开
- 按钮和输入框是否堆叠
- 文字是否可读

### 步骤 5: 无障碍检查

- [ ] 使用 Tab 键遍历所有交互元素
- [ ] 聚焦时有清晰的轮廓
- [ ] 所有按钮有 `aria-label`
- [ ] 对话框有 `role="dialog"` 和 `aria-labelledby`

## 常见问题

### Q: 界面一片混乱,看不到任何样式

**A:** 检查浏览器控制台是否有 CSS 加载错误。确认:
1. `src/renderer/main.tsx` 导入了 `./styles-v2.css`
2. 新的 CSS 文件都在 `src/renderer/` 目录下
3. 没有语法错误 (缺失分号、括号不匹配等)

### Q: 按钮大小和间距不对

**A:** 确保使用了正确的类名:
```tsx
// ❌ 错误
<button className="primary">保存</button>

// ✅ 正确
<button className="btn btn-primary">保存</button>
```

### Q: 深色模式太暗了,能改成浅色吗?

**A:** 可以。在 `design-system.css` 中调整色阶:
```css
:root {
  --surface-0: #f9fafb;  /* 改为浅色 */
  --surface-1: #f3f4f6;
  /* ... */
  --text-primary: #111827;  /* 改为深色文字 */
}
```

### Q: 主题绿色不喜欢,能换成蓝色吗?

**A:** 可以。修改 `design-system.css`:
```css
:root {
  --primary-500: #3b82f6;  /* 蓝色 */
  --primary-600: #2563eb;
  --primary-700: #1d4ed8;
  --primary-glow: rgba(59, 130, 246, 0.18);
}
```

### Q: 动画太多了,能关掉吗?

**A:** 系统已支持 `prefers-reduced-motion`。用户在操作系统中关闭动画即可。

或者在 `design-system.css` 中全局禁用:
```css
* {
  animation: none !important;
  transition: none !important;
}
```

## 回退方案

如果新样式有严重问题,可以临时回退:

1. 编辑 `src/renderer/main.tsx`:
   ```tsx
   import './styles.css';       // 恢复旧样式
   import './modern-controls.css';
   ```

2. 重启应用即可

## 性能检查

新设计系统应该**更快**,因为:
- 使用 CSS 变量减少重复计算
- 减少了选择器复杂度
- 优化了动画性能 (仅 transform/opacity)

如果感觉变慢,检查:
1. 浏览器是否在硬件加速
2. 是否有大量嵌套的 transform
3. 控制台是否有性能警告

## 下一步优化

完成迁移后,可以考虑:

1. **添加主题切换**
   ```tsx
   const [theme, setTheme] = useState('dark');
   document.documentElement.dataset.theme = theme;
   ```

2. **自定义配色**
   让老师选择自己喜欢的主题色

3. **更多动画**
   列表项交错进入、页面切换过渡等

4. **暗色/亮色自动切换**
   跟随系统主题

## 技术支持

遇到问题可以:
1. 查看 `FRONTEND-REDESIGN.md` 了解设计理念
2. 参考 `tools/frontend-skills-toolbox/` 的最佳实践
3. 检查浏览器控制台的错误信息
4. 使用 Git 查看具体改动: `git diff src/renderer/`

## 迁移完成标志

当以下所有项都打勾,说明迁移成功:

- [ ] 所有页面渲染正常
- [ ] 按钮和表单可交互
- [ ] 响应式布局工作正常
- [ ] 无障碍功能正常
- [ ] 没有控制台错误
- [ ] 性能没有下降
- [ ] 所有业务功能正常

祝迁移顺利! 🎉
