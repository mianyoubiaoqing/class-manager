# 班级管理客户端前端重制说明

## 已完成的工作

### 1. 全新设计系统 (Design System v2.0)

基于你的设计理念和项目内置的frontend-skills工具箱,我创建了完整的现代化设计系统:

#### 核心设计决策

**色彩系统 — 温润教育风格**
- 采用**深色模式**降低长时间使用的视觉疲劳
- **陶土暖调基底** (surface-0 到 surface-4) 避免冷冰冰的科技感
- **学术绿主题色** (#22c55e) 传递教育、成长的积极信号
- **琥珀强调色** (#f59e0b) 用于警示和重要提示
- 所有中性灰带有微妙的暖调,避免死气沉沉的纯灰

**排版系统 — 流式响应**
- 使用 `clamp()` 实现真正的响应式字号
- 从 xs (0.688rem) 到 4xl (3rem) 的完整字阶
- 针对数据使用 `tabular-nums` 确保对齐
- 行高分级: tight (1.25) 到 loose (1.75)

**空间系统 — Token化**
- 从 4px 到 64px 的标准间距 token
- 圆角 token: sm (8px) 到 pill (999px)
- 所有组件复用 token,避免魔法数字

**动效 — 物理弹簧**
- `--ease-spring`: cubic-bezier(0.16, 1, 0.3, 1) 模拟自然减速
- 只对 `transform` 和 `opacity` 做动画
- 尊重用户的 `prefers-reduced-motion` 设置

#### 创建的样式文件

```
src/renderer/
├── design-system.css    # 设计系统基础 (色彩/字体/token)
├── app-layout.css       # 应用框架布局 (侧栏/顶栏/主区)
├── components.css       # 通用组件 (按钮/卡片/表格/对话框)
├── conversation.css     # 对话工作区专用样式
└── styles-v2.css        # 统一入口 + 业务组件
```

### 2. 为0基础老师优化的设计决策

#### 降低认知负担

1. **侧栏常驻导航**
   - 清晰的视觉层级 (品牌区 → 快速操作 → 功能导航 → 班级列表)
   - 当前选中项有明确的视觉反馈 (左侧指示条 + 背景色)
   - 图标 + 文字标签,不需要记忆图标含义

2. **模式切换器**
   - 智能助教模式 vs 专业工坊模式
   - 药丸形状的切换器,当前模式突出显示
   - 降低模式切换的理解成本

3. **通知系统**
   - 4种清晰的状态: 成功(绿)/错误(红)/警告(琥珀)/信息(蓝)
   - 大图标 + 明确的标题 + 详细说明
   - 错误代码以等宽字体独立显示,便于技术支持

4. **对话界面**
   - 清晰的用户/助手气泡区分
   - AI 操作以"任务卡片"形式展示,有明确的状态徽章
   - 提议变更用蓝色卡片突出,diff对比清晰
   - 确认复选框用绿色背景强调,减少误操作

5. **空状态**
   - 大图标 + 清晰的标题 + 引导性描述
   - 提供启动器胶囊(Starter Capsules)降低首次使用门槛

#### 现代化控件

1. **按钮系统**
   - Primary (主操作) / Secondary (次要) / Ghost (幽灵)
   - 明确的悬停反馈 (上浮动画)
   - 禁用态降低透明度,不可点击

2. **输入框**
   - 聚焦时有清晰的边框 + 发光效果
   - 占位符颜色柔和,不干扰输入

3. **表格**
   - 表头固定,便于浏览长列表
   - 行悬停高亮
   - 数字列右对齐且使用等宽数字

4. **卡片**
   - 统一的阴影深度
   - 悬停时上浮 + 阴影加深
   - 交互式卡片有明确的指针光标

### 3. 遵循的设计原则

#### Impeccable (精工雕琢)

✅ **绝对禁止伪交互** — 所有 `cursor: pointer` 都有真实动作  
✅ **状态完整性闭环** — 按钮有 5 种状态(Default/Hover/Active/Focus/Disabled)  
✅ **零布局偏移** — 使用 `box-shadow` 模拟边框,避免悬停时推挤  
✅ **长文本防御** — 所有动态文本都有 `overflow-wrap: anywhere`

#### Frontend Design (拒绝AI俗套)

✅ **大胆的美学方向** — 温润教育风,不是冷科技  
✅ **带品牌底色的中性灰** — 陶土暖调,不是死气沉沉的纯灰  
✅ **避免 AI 指纹**:
   - ❌ 荧光青配深黑
   - ❌ 紫色到粉色的高饱和渐变
   - ❌ 毫无目的的毛玻璃模糊

✅ **合理使用卡片** — 不是所有东西都装进卡片  
✅ **非对称布局** — metrics-grid 使用 `auto-fit`,starter-capsules 用 `auto-fill`  
✅ **物理弹簧动效** — 自然的减速曲线,不是线性

### 4. 无障碍支持

✅ **键盘导航** — 所有交互元素支持 Tab 聚焦  
✅ **焦点可见性** — 3px 的 outline 清晰标识当前焦点  
✅ **减少动画** — 尊重 `prefers-reduced-motion`  
✅ **高对比度** — 响应 `prefers-contrast: high`  
✅ **语义化标签** — 使用 `<nav>`, `<main>`, `<dialog>` 等  
✅ **屏幕阅读器友好** — `.sr-only` 类提供额外上下文

### 5. 响应式适配

- **桌面 (1440px+)**: 完整布局,侧栏 280px
- **笔记本 (1024px)**: 侧栏收窄至 240px
- **平板 (768px)**: 侧栏变为可收起的固定层
- **手机 (<768px)**: 单列布局,操作器占满宽

## 下一步工作

### 立即需要做的

1. **替换旧样式**
   ```tsx
   // src/renderer/main.tsx 中
   import './styles-v2.css';  // 替换 './styles.css'
   ```

2. **更新 App.tsx 的类名映射**

需要系统性地将现有组件的类名映射到新设计系统:

#### 按钮类名映射
```tsx
// 旧 → 新
className="primary" → className="btn btn-primary"
className="icon-button" → className="btn btn-icon"
className="icon-button outlined" → className="btn btn-icon btn-secondary"
className="danger" → className="btn btn-primary" style={{ background: '#ef4444' }}
```

#### 布局类名映射
```tsx
// 应用框架
className="app-shell" → 保持不变
className="sidebar" → 保持不变
className="topbar" → 保持不变
className="content" → className="workspace"

// 侧栏组件
className="brand" → className="sidebar-brand"
className="brand-mark" → className="brand-icon"
className="nav-item" → 保持不变
className="nav-item selected" → className="nav-item active"
```

#### 组件类名映射
```tsx
// 通知
className="notice success" → className="notice notice-success"
className="notice error" → className="notice notice-error"

// 指标卡片
className="metrics" → className="metrics-grid"

// 表格
className="table-scroll" → className="table-container"
保留 .table-wrapper 和 .table

// 空状态
className="empty-state" → 保持不变

// 对话
className="conversation-page" → className="conversation-workspace"
```

3. **验证关键流程**
   - 启动应用,检查侧栏和顶栏渲染
   - 进入对话模式,测试消息发送
   - 检查表格、表单等基础组件
   - 测试响应式布局(缩放浏览器窗口)

### 可选的增强

1. **添加过渡动画**
   ```css
   /* 页面切换淡入 */
   .workspace > * {
     animation: fadeIn 0.3s var(--ease-smooth);
   }
   
   /* 列表交错动画 */
   .table tbody tr {
     animation: slideUp 0.3s var(--ease-spring);
     animation-fill-mode: backwards;
   }
   .table tbody tr:nth-child(1) { animation-delay: 0.05s; }
   .table tbody tr:nth-child(2) { animation-delay: 0.10s; }
   /* ... */
   ```

2. **浅色模式支持**
   如需添加浅色模式,在 design-system.css 中添加:
   ```css
   @media (prefers-color-scheme: light) {
     :root {
       --surface-0: #ffffff;
       --surface-1: #f9fafb;
       /* ... */
       --text-primary: #111827;
       /* ... */
     }
   }
   ```

3. **自定义主题色**
   可以添加主题选择器,让老师选择自己喜欢的主题:
   ```tsx
   <select onChange={(e) => document.documentElement.dataset.theme = e.target.value}>
     <option value="green">学术绿 (默认)</option>
     <option value="blue">宁静蓝</option>
     <option value="amber">温暖琥珀</option>
   </select>
   ```

## 设计理念总结

这套设计系统的核心是**降低认知成本**:

1. **温暖而非冷漠** — 陶土暖调替代冷科技感
2. **明确而非模糊** — 清晰的状态反馈和操作结果
3. **引导而非困惑** — 空状态提供行动建议,而不是冷冰冰的"暂无数据"
4. **流畅而非生硬** — 物理弹簧动效模拟自然交互
5. **一致而非混乱** — Token 化的间距、圆角、色彩系统

这是一个**为教育场景深度定制的设计系统**,而不是通用的 UI 框架套壳。

## 技术细节

### CSS 架构

采用**模块化分层架构**:

```
styles-v2.css (入口)
├── design-system.css (基础层)
│   ├── CSS 变量定义
│   ├── 全局重置
│   └── 工具类
├── app-layout.css (布局层)
│   ├── 应用框架
│   ├── 侧栏
│   ├── 顶栏
│   └── 主工作区
├── components.css (组件层)
│   ├── 按钮/输入/卡片
│   ├── 通知/徽章
│   ├── 表格/对话框
│   └── 加载/空状态
└── conversation.css (业务层)
    └── 对话工作区专用组件
```

### 命名约定

遵循 **BEM 轻量变体**:

- 块级元素: `.block-name`
- 元素: `.block-element`
- 修饰符: `.block-modifier` 或 `.block.modifier`

示例:
```css
.message-bubble { }
.message-bubble.user { }
.message-content { }
.message-meta { }
```

### 性能考虑

1. **CSS 变量继承** — 利用 CSS 变量的继承特性减少重复声明
2. **合理的选择器** — 避免过深的嵌套,保持在 3 层以内
3. **硬件加速** — 动画只使用 `transform` 和 `opacity`
4. **字体优化** — 使用系统字体栈,无需下载字体文件

### 浏览器兼容性

- **目标**: Electron 44+ (Chromium 130)
- **CSS 特性**: 现代 CSS Grid, Flexbox, CSS 变量, clamp()
- **不需要**: 前缀,polyfill,IE 兼容

## 迁移清单

- [x] 创建设计系统基础文件
- [x] 创建应用布局样式
- [x] 创建通用组件样式
- [x] 创建对话工作区样式
- [x] 创建统一入口文件
- [ ] 更新 main.tsx 导入新样式
- [ ] 更新 App.tsx 类名映射
- [ ] 测试所有业务页面渲染
- [ ] 测试响应式布局
- [ ] 进行无障碍审查
- [ ] 性能测试与优化

## 参考资源

- Frontend Skills Toolbox: `tools/frontend-skills-toolbox/`
- Impeccable 指南: `tools/frontend-skills-toolbox/core-design/impeccable/`
- Frontend Design 指南: `tools/frontend-skills-toolbox/core-design/frontend-design/`
