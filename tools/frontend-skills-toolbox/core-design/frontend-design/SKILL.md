---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications. Generates creative, polished code that avoids generic AI aesthetics.
license: Apache 2.0. Based on Anthropic's frontend-design skill.
---

# Frontend Design — 拒绝 AI 通用审美的前端视觉设计指南

本指南用于指导创造高度个性化、具备强烈视觉辨识度与卓越做工的生产级前端界面。坚决抵制千篇一律的 “AI 俗套审美 (AI Slop)”。

## 1. 核心设计原则 (Design Direction)

### 设定大胆的美学方向 (Commit to a BOLD Direction)

在动笔编写任何代码前，必须明确界面的灵魂：

- **目标场景与受众 (Purpose)**：这个界面解决什么核心问题？为谁服务？在什么物理环境或情境下使用？
- **基调与风格倾向 (Tone)**：从极端的风格中选取契合业务的基调：
  - 精炼严谨 (Academic / Utilitarian / Minimalist)
  - 杂志编排 (Editorial / Magazine)
  - 复古未来 (Retro-Futuristic / Synthwave)
  - 温润人文 (Organic / Warm Paper / Nature Distilled)
  - 活泼玩具感 (Claymorphism / Soft 3D)
  - 新野兽派 (Brutalism / High Contrast)
- **差异化记忆点 (Differentiation)**：这个界面最让人过目不忘的**一个核心特征**是什么？

---

## 2. 视觉审美细则 (Aesthetics Guidelines)

### A. 排版体系 (Typography)

- **拒绝过度使用的平凡字体**：尽量避免滥用没有任何性格的 Arial, Inter, Roboto 作为主视觉展示。
- **阶梯字阶与流式缩放**：善用 `clamp()` 进行流式排版，拉开字重（400 vs 600/700）与字号的悬殊对比，建立森严的视觉层级。
- **不要把大号圆角图标放在每个标题上方**：这种做法会让界面极其模板化、廉价化。
- **Tabular Nums**：所有数据列、计数器、倒计时必须配置 `font-variant-numeric: tabular-nums`。

### B. 色彩与主题 (Color & Theme)

- **采用主导色 + 锋利强调色**：平庸均摊的调色板毫无辨识度。
- **中性灰必须带品牌底色微调 (Tinted Neutrals)**：绝对不要使用死气沉沉的纯 `#000` 或纯 `#808080`，自然界中没有纯灰，加入少量品牌色调（如冷灰蓝、墨绿灰、暖沙灰）能形成潜意识的高级和谐感。
- **杜绝 AI 审美指纹**：
  - ❌ 荧光青配深黑背景
  - ❌ 紫色到粉色的高饱和度渐变文字（AI Purple Gradient）
  - ❌ 在原本就发光的界面上乱加发光阴影

### C. 空间布局与节奏 (Layout & Space)

- **不要将所有东西都装进卡片里 (Don't wrap everything in cards)**：卡片套卡片会导致严重的视觉噪音，合理利用空白、分隔线和字阶弱化边框。
- **避免机械等宽网格**：打破千篇一律的 `repeat(3, 1fr)`，尝试非对称布局、主次分明的 Bento Grid 或流式居中。
- **黄金阅读视宽**：文本长流控制在 680px ~ 820px 之间，避免在大显示器上文字被无节制拉宽导致眼球疲劳。

### D. 动效与交互物理学 (Motion & Interaction)

- **高冲击力时刻优先**：一个有韵律的进入动效远胜于几十个杂乱的微交互。
- **物理弹簧与阻尼 (Spring Curves)**：
  - 使用 `cubic-bezier(0.16, 1, 0.3, 1)` 等指数减速曲线，模拟自然物体减速；
  - 仅对 `transform` 和 `opacity` 进行动效过渡，严禁对 `width`, `height`, `padding`, `margin` 直接写 transition。
- **渐进式暴露 (Progressive Disclosure)**：界面首屏保持纯净，高级选项与技术参数收纳于抽屉或折叠面板中。

---

## 3. 防 AI 俗套测试 (The AI Slop Test)

> **关键自检标准**：如果你把这个界面拿给一个挑剔的专业设计师看，对方会不会一眼认出：“这绝对是 AI 一键生成的”？
> 如果答案是肯定的，那么这个界面就必须重构。

**典型的 2024~2026 AI 俗套指纹清单**：

1. 大量无目的的毛玻璃模糊 (Glassmorphism Overuse)；
2. 满屏圆角卡片，且每张卡片都带有淡淡的青紫渐变发光外圈；
3. 一进页面就是大字号无意义的英文打字机动效；
4. 无论什么后台，满屏都是千篇一律的卡片网格 + 毫无逻辑的折线迷你图 (Sparklines)。
