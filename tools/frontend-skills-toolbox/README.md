# 前端设计与工程解耦工具箱 (Frontend Skills Toolbox)

本项目专属的前端设计与工程优化工具箱，完整安装并解耦集成了 GitHub 上最优秀的现代 AI 前端 Skills，包含核心视觉设计、做工打磨、UX 决策库、代码规范审查、Tailwind 样式架构与 Vue 3 全家桶最佳实践。

---

## 📦 包含的 Skills 与 GitHub 官方溯源

| 分类                 | Skill 名称                 | 核心职能                                                          | GitHub 来源仓库                                                                                 |
| :------------------- | :------------------------- | :---------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| **一、核心前端设计** | `frontend-design`          | 设定大胆美学方向，拒绝 AI 俗套审美 (AI Slop)，建立强视觉辨识度    | [anthropics/skills](https://github.com/anthropics/skills)                                       |
|                      | `impeccable`               | 生产级界面精工雕琢、做工底线、交互全状态闭环与打磨指令集          | [pbakaus/impeccable](https://github.com/pbakaus/impeccable)                                     |
|                      | `ui-ux-pro-max`            | UI/UX 决策库 (79种风格、192套配色、74组字体、119条UX准则)         | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) |
|                      | `web-design-guidelines`    | Vercel Labs Web 界面规范审查 (A11y 无障碍、对焦环、防溢出)        | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)                         |
| **二、样式与 CSS**   | `Tailwind CSS (v4+)`       | CSS-First 原生配置、`@theme`、`@utility`、响应式断点与暗色模式    | [agents-inc/skills](https://github.com/agents-inc/skills)                                       |
| **三、前端框架实现** | `vuejs-ai-skills (全家桶)` | 涵盖 Debug 排查、Options API、JSX 差异、Pinia 架构、Router 与测试 | [vuejs-ai/skills](https://github.com/vuejs-ai/skills)                                           |

---

## 🚀 为什么必须解耦 (Decoupling Architecture)？

1. **项目自闭环**：完全保存在项目 `tools/frontend-skills-toolbox/` 内，不受本机全局 `~/.claude/skills` 或 `~/.cursor/skills` 的版本飘移或缺失影响；
2. **无需额外依赖**：内置的 `fe-toolbox.mjs` 调度器采用原生 Node.js ES Module 编写，零第三方 npm 依赖，克隆即用；
3. **针对本项目深度优化**：定制了 Class Manager 专属的“学术现代主义 (Academic Modernism)”设计系统决策，并支持直接对 `src/renderer/` 进行代码级 Web Guidelines 自动化扫描。

---

## 🛠️ CLI 快捷指令

在项目根目录下，可通过配置的 npm 脚本或 node 直接调用：

```bash
# 1. 运行 Web Interface Guidelines 代码与无障碍审查
npm run fe:audit

# 2. 检索 UI/UX Pro Max 设计风格与色彩决策
npm run fe:search -- "education"
npm run fe:search -- "bento"

# 3. 查看行业与教育专用配色方案
npm run fe:toolbox colors

# 4. 查看 119 条 UX 交互规范
npm run fe:toolbox ux "contrast"

# 5. 查看 Tailwind v4+ 核心架构指南与红线禁忌
npm run fe:toolbox tailwind

# 6. 查看 Vue 3 全家桶工程指南概览
npm run fe:toolbox vue
```

---

## 📂 工具箱目录架构

```
tools/frontend-skills-toolbox/
├── README.md                           # 工具箱概览与溯源说明
├── TOOLBOX_MANUAL.md                   # 完整使用手册与各 Skill 的协作流 (Workflow)
├── bin/
│   └── fe-toolbox.mjs                  # 统一调度 CLI
├── core-design/                        # 一、核心前端设计
│   ├── frontend-design/
│   │   └── SKILL.md                    # 美学定势与防 AI 俗套测试
│   ├── impeccable/
│   │   └── SKILL.md                    # 生产级做工底线与 24 种打磨指令
│   ├── ui-ux-pro-max/
│   │   ├── SKILL.md                    # 设计决策智能库规范
│   │   ├── engine.mjs                  # 原生轻量检索引擎
│   │   └── data/
│   │       ├── styles.json             # 79 种 UI 风格库 (含专属学术现代主义)
│   │       ├── colors.json             # 192 种行业与教育配色
│   │       └── ux-rules.json           # 119 条 UX 交互准则
│   └── web-design-guidelines/
│       ├── SKILL.md                    # Vercel Labs 规范指南
│       └── command.md                  # 官方完整代码审查规则清单
├── styling/                            # 二、样式 / CSS 工具
│   └── tailwindcss/
│       └── SKILL.md                    # Tailwind CSS v4+ 官方最佳实践
└── frameworks/                         # 三、前端框架实现 (Vue 3 全家桶)
    └── vue-skills/
        ├── vue-debug-guides.md         # 运行时排错与响应式丢失排查
        ├── vue-options-api-best-practices.md # Options API 规范
        ├── vue-jsx-best-practices.md   # Vue JSX 与 React JSX 差异
        ├── vue-pinia-best-practices.md # Pinia 状态管理最佳实践
        ├── vue-router-best-practices.md# Vue Router 4 导航守卫与路由复用
        └── vue-testing-best-practices.md# Vitest + Vue Test Utils 交互测试
```
