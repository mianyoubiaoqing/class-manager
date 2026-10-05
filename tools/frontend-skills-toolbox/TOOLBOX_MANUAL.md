# 前端工具箱协作流与操作手册 (Toolbox Manual)

当您或 AI 助手需要对 `class-manager` 的某个页面或组件进行优化时，请遵循以下标准流水线（涵盖 6 大 Skills 的分工协作）：

---

## 阶段一：美学定势与设计决策 (frontend-design + ui-ux-pro-max)

1. **确定页面模式 (Mode)**：
   - 业务管理流（名册、排座、成绩、备课、值日）属于 **Operate 模式**，首要保证扫视效率、键盘可访问性与沉静耐看；
   - 业务助手对话流属于 **Operate + Read** 混合流，采用 ChatGPT 黄金 800px 视宽与悬浮胶囊；
2. **检索设计决策库 (ui-ux-pro-max)**：
   ```bash
   npm run fe:search -- "classroom"
   ```
   获得推荐的配色体系、字体搭配与卡片网格规范；
3. **通过防 AI 俗套测试 (AI Slop Test)**：
   - 拒绝大面积毫无逻辑的紫色霓虹渐变；
   - 拒绝到处滥用毛玻璃（Glassmorphism）与卡片套卡片；
   - 拒绝大号无意义图标堆砌在每个标题上方。

---

## 阶段二：生产级做工打磨 (impeccable)

在完成页面代码初稿后，对照 `impeccable` 做工底线进行专项加固：

1. **`distill` (降噪提炼)**：
   - 彻底隐藏或剥离页面中生硬的工程调试杂音（如图片中曾出现的“本轮完成 / 对象 / 供应商 / 脱敏详情 / 尚未执行”）；
   - 将必要的技术参数收纳至抽屉或折叠明细中；
2. **`harden` (健壮性与溢出防御)**：
   - 确保表格单元格和卡片具备 `overflow-wrap: anywhere`；
   - 确保 Flex 容器内的子级带有 `min-width: 0`；
   - 检查极长名字、特殊学号或空状态（Empty States）下的排版表现；
3. **`animate` (物理阻尼微动效)**：
   - 使用 `cubic-bezier(0.16, 1, 0.3, 1)`（Spring Curve）；
   - 仅对 `transform` 和 `opacity` 进行过渡，避免重排抖动；
   - 悬停（Hover）与按压（Active）提供明显的微位移与下沉缩放。

---

## 阶段三：样式架构与令牌收敛 (Tailwind & Tokens)

1. **收敛至 CSS 自定义属性**：
   - 避免在非全局区域硬编码特定十六进制颜色（如 `#123456`）；
   - 统一使用 `var(--primary)`、`var(--border-color)`、`var(--text-primary)`；
2. **响应式断点完备**：
   - 检查小屏笔记电脑与大屏桌面显示器的布局适应性；
   - 侧边栏折叠时，主内容区平滑延展填满。

---

## 阶段四：规范审查与无障碍闭环 (web-design-guidelines)

在提交代码前，运行自动化审查工具：

```bash
npm run fe:audit
```

工具将严格依据 Vercel Labs 规范扫描：

- 纯图标按钮是否补充了 `aria-label`；
- 输入框是否拥有语义化标签；
- 是否存在单独书写 `outline: none` 抹杀焦点环的情况；
- 是否意外泄漏了开发期工程防御提示文字。

---

## 阶段五：工程状态与测试守卫 (Vue / React Best Practices)

- **单向数据流与 CAS 状态防护**：
  - 不在局部视图任意篡改数据库底层快照；
  - 依赖 CAS 事务与整库快照替换，确保数据确定性；
- **测试不变量守护**：
  - 任何视觉重构，均需确保 Playwright Smoke 测试关心的语义标签（如 `heading('业务对话')`、`heading('本轮完成')`、`#conversation-input`）在 DOM 中可达且可测。
