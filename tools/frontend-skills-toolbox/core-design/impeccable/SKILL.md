---
name: impeccable
description: Use when the user wants to design, redesign, shape, critique, audit, polish, clarify, distill, harden, optimize, adapt, animate, colorize, extract, or otherwise improve a frontend interface. Covers websites, dashboards, product UI, components, forms, and micro-interactions.
version: 4.5.0
license: Apache 2.0
---

# Impeccable — 生产级前端精工雕琢与做工底线指南

Impeccable 是一套严苛的工艺审查与界面打磨哲学。它拒绝平庸妥协，要求将每一次前端界面的产出当做设计大奖级别的作品来雕琢。

## 1. 界面模式分类 (Modes)

在着手设计或重构具体页面时，首先明确该界面的首要成功标准：

- **Operate (操作与生产)**：访客的目标是高效完成业务任务（后台、班级管理、成绩录入、排座工坊、系统设置）。
  - **核心准则**：扫视效率第一、交互预期稳定、键盘无障碍支持、消除干扰。品牌感融于精准细节而非喧宾夺主。
- **Read (阅读与理解)**：访客的目标是吸收结构化信息（文档、学生成长档案、试卷讲评说明）。
  - **核心准则**：黄金视宽、舒适行高 (1.65~1.75)、呼吸感字距与柔和背景。
- **Persuade (说服与决断)**：落地页、品牌宣传、产品功能大图展示。
  - **核心准则**：强烈的情感共鸣、真实高质量图像、明确不犹豫的 CTA 按钮。
- **Experience (沉浸体验)**：3D 交互、视差演示、全屏交互作品。

---

## 2. 常用打磨指令集 (Playbook Commands)

| 指令      | 目标领域   | 核心动作                                                                     |
| :-------- | :--------- | :--------------------------------------------------------------------------- |
| `polish`  | 最终质检   | 消除最后 1% 的缝隙失真、对齐瑕疵、间距不匀与字体毛边                         |
| `distill` | 降噪提炼   | 剥离非核心的防御性文字、多余卡片边框与技术术语                               |
| `harden`  | 健壮性加固 | 补齐错误状态、超长字段截断/换行防护、无网络占位符、i18n 多语言测试           |
| `bolder`  | 强化辨识度 | 针对过于单调保守的界面，拉大对比度、引入鲜明主题色与非对称节奏               |
| `quieter` | 视觉降噪   | 针对过于刺眼、动效过量或颜色杂乱的界面进行静音沉静处理                       |
| `adapt`   | 跨端自适应 | 检验 375px (手机)、768px (平板)、1024px (小屏本)、1440px+ 宽屏下的布局自适应 |
| `clarify` | 文案净化   | 用温和、明确、行动导向的人性化文案替代程序员思维的报错代码与免责声明         |
| `animate` | 赋予生命力 | 添加有目的的物理弹簧过渡与呼吸反馈，消除突兀生硬的 DOM 跳变                  |

---

## 3. 做工底线守则 (Craft Floor Rules)

1. **绝对禁止伪交互**：所有看起来能点的地方（鼠标悬停变手型 `cursor: pointer`）必须有真实的反馈和明确动作；没有动作的元素绝不可加手型。
2. **状态完整性闭环**：每一个按钮或表单输入框，必须具备完整的 5 种状态表现（Default, Hover, Active, Focus-Visible, Disabled）。
3. **零布局偏移 (Zero Layout Shift)**：鼠标悬停、激活或展开时，严禁因为边框加粗 (`border: 1px` -> `2px`) 导致相邻元素被推挤晃动，使用 `box-shadow` 或内描边保持盒模型刚性。
4. **长文本防御 (Text Wrap & Overflow)**：表格和卡片中的任意动态文本字段，必须具备 `overflow-wrap: anywhere` 或截断机制，绝不允许长学号、长名字或长英文 URL 撑破容器。
