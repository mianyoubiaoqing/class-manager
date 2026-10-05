---
name: web-styling-tailwind
description: Tailwind CSS v4+ Patterns - utility-first CSS framework with CSS-first configuration. Use when writing, migrating, or optimizing Tailwind CSS utility classes, theme variables, custom variants, and responsive layouts.
version: 4.1.0
license: MIT
---

# Tailwind CSS v4+ 官方最佳实践与架构指南

> **核心提示**：Tailwind CSS v4 完全采用 CSS 原生配置，彻底废弃了传统的 `tailwind.config.js`。
>
> - `@import "tailwindcss";` 取代了原有的三个 `@tailwind` 指令；
> - `@theme` 取代了 `tailwind.config.js` 中的 `theme.extend`；
> - 自定义工具类使用 `@utility`，自定义变体使用 `@custom-variant`；
> - 无需再配置 `content: [...]` 数组，引擎会自动扫描源码。

---

## 1. 核心架构模式 (Core Patterns)

### 模式 1：CSS-First 配置与主题定义

```css
@import 'tailwindcss';

@theme {
  --color-primary: #177a62;
  --color-primary-hover: #10654f;
  --color-canvas: #f8fafb;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  --radius-card: 14px;
}
```

### 模式 2：响应式断点 (Responsive Design)

Mobile-First 移动优先原则，无前缀为基础样式，断点前缀为覆盖样式：

```html
<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
  <!-- 自适应卡片网格 -->
</div>
```

### 模式 3：暗色模式变体 (Dark Mode)

通过 `@custom-variant` 自定义暗色选择器：

```css
@import 'tailwindcss';

/* 类名切换方案 */
@custom-variant dark (&:where(.dark, .dark *));

/* 或属性切换方案 */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

### 模式 4：动态类名合并与冲突解决 (Class Composition)

在 React / Vue 中统一封装 `cn()` 辅助函数，避免手动拼接字符串：

```typescript
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

---

## 2. 常见禁忌与红线清单 (Red Flags)

- ❌ **严禁使用已失效的 v3 语法**：
  - `@tailwind base; @tailwind components; @tailwind utilities;`（在 v4 中无任何输出）；
  - `tailwind.config.js`（默认被忽略，除非有显式 `@config` 指令）；
  - `@layer utilities { ... }`（生成的类名无法接收 `hover:` 等变体前缀，必须改用 `@utility`）。
- ❌ **严禁随意写 `transition: all`**：
  - 必须显式声明变化的属性（如 `transition-colors`, `transition-transform`, `transition-opacity`）。
- ❌ **避免使用 `outline-none` 抹杀焦点**：
  - 必须配套高辨识度的焦点环（如 `focus-visible:ring-2 focus-visible:ring-emerald-600`）。
