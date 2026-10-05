---
name: ui-ux-pro-max
description: UI/UX design intelligence database. 79 searchable styles (50 active), 192 color palettes, 74 font pairings, 25 chart types, 119 UX guidelines, 192 industry reasoning rules.
version: 2.6.0
license: MIT
---

# UI/UX Pro Max — 智能设计决策与风格数据库

UI/UX Pro Max 沉淀了业界顶级的 UI/UX 知识库与设计决策系统。

## 1. 核心数据库规格

- **79 种 UI 风格 (50 Active)**：从新瑞士主义、极简主义、玻璃拟态、粘土拟态、新野兽派到 Bento Grid、Bento Box 与 OLED 深色模式；
- **192 套行业配色方案 (Color Palettes)**：覆盖 SaaS、教育、医疗、金融、管理后台等 192 种业务形态；
- **74 组字体搭配 (Font Pairings)**：经专业排版师校准的标题与正文搭配组合；
- **119 条 UX 交互准则 (UX Guidelines)**：包含触控目标尺寸、对比度、防抖防重复提交、长文本折行与异常处理；
- **192 条行业推理决策规则 (Reasoning Rules)**：根据产品类别自动推荐落地页模式、主打风格与严禁使用的设计反模式。

---

## 2. 工具箱本地运行指令

在工具箱中已内置无需外部依赖的 Node.js 轻量级决策检索引擎：

```bash
# 查询设计风格推荐（例如教育管理、极简、后台等）
node tools/frontend-skills-toolbox/bin/fe-toolbox.mjs search "education school classroom"

# 查询特定风格详情
node tools/frontend-skills-toolbox/bin/fe-toolbox.mjs style "minimalism-and-swiss-style"

# 查询 UX 交互准则
node tools/frontend-skills-toolbox/bin/fe-toolbox.mjs ux "contrast"
```

---

## 3. 专业 UI 通用检查清单 (Pre-Delivery Checklist)

- [ ] **杜绝表情包作图标**：严禁直接用 `🚀`、`🎨`、`📊` 充当严肃业务系统的 UI 图标，统一使用标准 SVG 图标库（如 Lucide / Heroicons）；
- [ ] **悬停状态稳定**：鼠标悬停仅做色值、阴影或内发光微调，严禁用大幅度 scale 导致布局发生抖动；
- [ ] **高辨识度外框**：在浅色与中性灰背景下，卡片边框必须清晰可见（如 `border: 1px solid var(--border-color)`）；
- [ ] **文本对比度合格**：主要文字对比度必须达到 WCAG AA 级要求（$\ge 4.5:1$），弱提示文字 $\ge 3:1$；
- [ ] **响应式自适应**：在 375px、768px、1024px、1440px 下无任何水平滚动条泄漏。
