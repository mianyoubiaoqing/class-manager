# Class Manager 前端设计与体验优化工具箱
## Frontend Optimization Toolbox (Synthesized Edition)

本工具箱整合了业界顶级前端设计体系的核心方法论，专为 **Class Manager**（React 19 + TypeScript + Electron + Vite）深度定制，涵盖**视觉美学定位、生产级做工打磨、UX决策矩阵、Web规范自动化审查、设计令牌与工程状态流**六大核心支柱。

---

## 目录
1. [六大体系融通图谱](#一-六大体系融通图谱)
2. [美学设计原则：学术现代主义 (frontend-design)](#二-美学设计原则学术现代主义-frontend-design)
3. [生产级做工与微动效物理学 (impeccable)](#三-生产级做工与微动效物理学-impeccable)
4. [UI/UX 决策矩阵与认知心理学 (ui-ux-pro-max)](#四-uiux-决策矩阵与认知心理学-ui-ux-pro-max)
5. [Web 界面规范与自动化审查器 (web-design-guidelines)](#五-web-界面规范与自动化审查器-web-design-guidelines)
6. [设计令牌体系与 CSS 架构 (Tailwind & Tokens)](#六-设计令牌体系与-css-架构-tailwind--tokens)
7. [前端工程最佳实践与状态防护 (Engineering Best Practices)](#七-前端工程最佳实践与状态防护-engineering-best-practices)

---

## 一、 六大体系融通图谱

```
                        ┌──────────────────────────────────────────────┐
                        │         前端优化工具箱 (Design Toolbox)        │
                        └──────────────────────┬───────────────────────┘
                                               │
       ┌───────────────────────────────┬───────┴───────────────────────┬───────────────────────────────┐
       ▼                               ▼                               ▼                               ▼
1. 视觉美学 (frontend-design)   2. 交互打磨 (impeccable)      3. 决策矩阵 (ui-ux-pro-max)     4. 代码审查 (web-guidelines)
   • 拒绝通用AI紫/千篇一律模板     • Spring 物理阻尼微动效        • 119条UX心理学准则             • npm run audit:ui 自动化工具
   • 学术墨绿 + 纸面中性灰        • 交互全状态闭环 (Hover/Active) • Fitts / Hick / Jakob 定律    • file:line 格式错误诊断
   • 黄金阅读视宽 (800px)         • WCAG 2.1 AA 级无障碍        • 79种风格与调色板预设          • 防御性技术文字泄漏拦截
       │                                                                                               │
       └───────────────────────────────┬───────────────────────────────┬───────────────────────────────┘
                                       ▼                               ▼
                        5. 样式架构 (Tailwind/Tokens)   6. 工程范式 (Engineering & State)
                           • CSS 自定义属性原子系统        • 单向数据流与 CAS 事务快照
                           • 极速热重载与模块化隔离        • 自动化 Smoke 契约防护 (零功能降级)
```

---

## 二、 美学设计原则：学术现代主义 (frontend-design)

### 1. 刻意避开“AI 通用审美”
- **坚决弃用**：饱和度过高的通用紫色渐变、大面积粗暴半透明磨砂、浮夸的发光阴影和毫无逻辑的装饰性几何。
- **立足场景**：面向中学教师群体的日常教学与班主任业务。教师需要的是**沉静、专注、专业、高密度信息下依然清爽耐看**的数字空间。

### 2. 空间节奏与布局定势
- **800px 居中沉浸流**：
  在桌面端屏幕上，过宽的内容行宽会导致视线频繁跳跃。对话流严格限制为 `max-width: 820px; margin: 0 auto;`，提供类似纸质教案的阅读节奏。
- **双模协同空间 (Dual-Mode Elastic Architecture)**：
  - **智能助理模式 (Agent Canvas)**：专注于意图识别、轻量微卡片与对话流，还给教师最纯净的输入心流。
  - **专业工坊模式 (Focus Studio)**：全屏网格式的高效手动工具（排座、成绩大表、值日轮换、资料切片）。

---

## 三、 生产级做工与微动效物理学 (impeccable)

### 1. Spring 弹簧物理阻尼微动效
摒弃生硬的 `linear` 或标准 `ease-in-out`，全面引入符合真实物理世界的弹簧曲线：

```css
:root {
  /* 弹性轻盈展开：适用于侧栏滑动、卡片悬浮提升、弹出层 */
  --ease-spring: cubic-bezier(0.16, 1, 0.3, 1);
  /* 丝滑状态切换：适用于颜色渐变、光晕聚焦 */
  --ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);
}
```

### 2. 交互状态全闭环清单
每个交互组件必须完备支持以下 6 种状态，严禁出现“点了没反应”或“失焦后样式错乱”：
1. **Default (默认)**：清晰的层级与边框，弱对比阴影；
2. **Hover (悬停)**：微上浮 1~2px（`transform: translateY(-2px)`），边框提亮至主色，阴影增强；
3. **Active (按压)**：瞬间下沉缩放（`transform: scale(0.98)`），给予坚实的物理按压感；
4. **Focus-Visible (键盘聚焦)**：保留高辨识度的外发光对焦环（`box-shadow: 0 0 0 3px var(--primary-ring)`），无障碍友好；
5. **Disabled (禁用)**：置灰降暗，鼠标显示 `not-allowed`，同时移除悬停位移；
6. **Loading (加载中)**：内嵌微脉冲波纹（Pulse Glow）或呼吸动效，消除机械冻结感。

---

## 四、 UI/UX 决策矩阵与认知心理学 (ui-ux-pro-max)

在进行任何前端界面重构与新页面设计时，严格对照以下 UX 心理学定律做决策：

| UX 认知定律 | 设计决策与落地规范 | 违反该定律的负面表现 |
| :--- | :--- | :--- |
| **Fitts's Law (菲茨定律)** | 发送按钮、收起侧栏、开启新对话的有效点击区域保持 $\ge 32\text{px}$，贴近视线聚集区。 | 小于 24px 的微小图标，鼠标极易点歪。 |
| **Hick's Law (席克定律)** | 首屏仅提供 6 张高频场景启动胶囊；技术细节（脱敏、耗时、供应商）默认隐藏。 | 一进页面堆砌几十个开关，教师产生认知超载。 |
| **Miller's Law (7±2 原则)** | 主导航左侧栏控制在一级核心业务，工坊内部按阶段划分步骤（Tab 化）。 | 侧边栏过长，滚动条失控，找不到功能。 |
| **Jakob's Law (雅各布定律)** | 对话界面对齐 ChatGPT 的成熟范式：居中流、右对齐用户气泡、悬浮药丸 Composer。 | 自创怪异的聊天室界面，强迫用户重新学习。 |
| **Aesthetic-Usability Effect** | 规整的网格对齐、柔和的阴影与高对比度文字，赋予系统高可靠度与安全性。 | 粗糙排版引发教师对数据丢失的焦虑感。 |

---

## 五、 Web 界面规范与自动化审查器 (web-design-guidelines)

本项目内置了自动化代码级审查工具 `tools/design-toolkit/audit-ui.mjs`。

### 运行方式
在项目根目录下执行：
```bash
npm run audit:ui
```

### 检查规则集
1. `a11y/button-accessible-name`：纯图标按钮是否缺失 `aria-label` 或 `title`；
2. `a11y/interactive-role`：非标准元素 (`div`/`span`) 绑定 `onClick` 时是否缺失 `role="button"` 或 `tabIndex`；
3. `a11y/input-accessible-name`：输入控件是否具备关联的 `label` 或 `aria-label`；
4. `ux/defensive-jargon-leak`：是否在生产界面泄露了开发期工程防御文字（如“合成数据验证”、“桌面回包不明”）；
5. `design-tokens/no-hardcoded-colors`：非变量区硬编码色值提示，引导收敛至 Design Tokens。

---

## 六、 设计令牌体系与 CSS 架构 (Tailwind & Tokens)

设计规范以全局 CSS 自定义属性统一管理于 `src/renderer/styles.css`：

```css
:root {
  /* 品牌主色 (Brand Tokens) */
  --primary: #177a62;
  --primary-hover: #10654f;
  --primary-active: #0c4e3d;
  --primary-light: #eaf4f0;
  --primary-subtle: #f1f8f5;
  --primary-ring: rgba(23, 122, 98, 0.22);

  /* 画布与表面 (Surfaces) */
  --bg-canvas: #f8fafb;
  --bg-surface: #ffffff;
  --bg-muted: #f1f4f6;

  /* 边框体系 (Borders) */
  --border-color: #e2e7ea;
  --border-subtle: #edf1f3;
  --border-hover: #cbd5d8;

  /* 文字可读性 (Typography) */
  --text-primary: #1a2228;
  --text-secondary: #4a5761;
  --text-muted: #798791;

  /* 漫射多层阴影 (Shadows) */
  --shadow-xs: 0 1px 2px rgba(16, 24, 40, 0.04);
  --shadow-sm: 0 2px 6px rgba(16, 24, 40, 0.05);
  --shadow-card: 0 4px 16px -2px rgba(16, 24, 40, 0.06);
  --shadow-float: 0 12px 32px -4px rgba(16, 24, 40, 0.12);
}
```

---

## 七、 前端工程最佳实践与状态防护 (Engineering Best Practices)

借鉴 Vue 3 / Pinia 深度最佳实践，在 React 19 + Electron 架构下实施：

1. **单向数据流与 CAS 状态防护**：
   - 绝不在 UI 组件内部随意篡改 Snapshot 状态；
   - 任何写入操作必须先经过本地预检，提交后端事务完成 CAS 校验后，通过整库拉取快照原子替换；
2. **测试不变量契约保护 (Zero Degradation Guarantee)**：
   - 界面视觉重塑无论如何激进，必须完整保留 Smoke 测试关心的所有语义标桩：
     - `heading('业务对话')`、`heading('今天想处理什么？')`、`heading('模型提议 · 尚未执行')`、`heading('本轮完成')`；
     - `page.getByLabel('发送消息')`、`page.getByRole('checkbox')`、`page.getByRole('navigation', { name: '主导航' })`。
   - 净化技术卡片时使用 `.task-trace-hidden`（利用绝对定位 `clip` 裁切并保留 DOM 可访问性），确保自动化测试不受任何负面影响。
3. **零告警纪律**：
   - 每次前端优化后必须通过 `npm run typecheck`、`npm run lint` 与 `npm run format:check` 三重流水线，保证 0 错误、0 警告。
