---
name: web-design-guidelines
description: Review UI code files against the Vercel Labs Web Interface Guidelines. Terse file:line findings covering accessibility, focus states, forms, animation, typography, and anti-patterns.
version: 1.0.1
license: Apache 2.0
---

# Web Interface Guidelines — 界面代码与无障碍规范审查

基于 Vercel Labs Web Interface Guidelines，自动化审查前端代码。

## 1. 核心规则集 (Core Rules)

- **无障碍 (Accessibility)**：
  - 纯图标按钮必须配置 `aria-label`；
  - 表单控件必须有关联 `<label>` 或 `aria-label`；
  - 交互元素按键处理支持；
  - `<button>` 用于交互触发动作，`<a>` 用于链接导航，严禁 `<div onClick>` 代替按钮；
  - 装饰性图标添加 `aria-hidden="true"`。
- **对焦环 (Focus States)**：
  - 严禁单独写 `outline: none`，必须配套 `:focus-visible` 外发光或对焦环。
- **动效 (Animation)**：
  - 尊重 `prefers-reduced-motion`；
  - 动效仅针对 `transform` 和 `opacity` 进行合成渲染；
  - 避免 `transition: all`，显式罗列属性。
- **排版 (Typography)**：
  - 省略号使用标准的单个字符 `…` 而非三个句点 `...`；
  - 数据与考分列配置 `font-variant-numeric: tabular-nums`；
- **排版防溢出 (Content Handling)**：
  - 容器必须配置 `overflow-wrap: anywhere` 或 `truncate`；
  - Flex 容器内部必须具备 `min-width: 0` 防止破版。

---

## 2. 自动化审查工具执行

在工具箱中运行：

```bash
node tools/frontend-skills-toolbox/bin/fe-toolbox.mjs audit
```

即可自动扫描 `src/renderer/` 下的所有 `.tsx` 和 `.css` 文件，并输出 VS Code 可点击跳转的 `file:line` 格式检查报告。
