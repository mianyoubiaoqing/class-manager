#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  colors,
  searchStyles,
  searchUx,
  styles,
  uxRules,
} from '../core-design/ui-ux-pro-max/engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLBOX_ROOT = resolve(__dirname, '..');
const PROJECT_ROOT = resolve(TOOLBOX_ROOT, '../..');
const RENDERER_DIR = join(PROJECT_ROOT, 'src/renderer');

const args = process.argv.slice(2);
const command = args[0] || 'help';

function printBanner() {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│ 🎨 Class Manager 前端设计与工程解耦工具箱 (Frontend Toolbox) │
│    集成: frontend-design · impeccable · ui-ux-pro-max       │
│          web-design-guidelines · Tailwind CSS · Vue Skills  │
└─────────────────────────────────────────────────────────────┘
`);
}

function runAudit() {
  console.log('🔍 开始执行 Web Interface Guidelines & A11y 全面审查...\n');
  const findings = [];

  function walk(dir, ext) {
    let results = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results = results.concat(walk(full, ext));
      } else if (ext.some((e) => entry.endsWith(e))) {
        results.push(full);
      }
    }
    return results;
  }

  const tsxFiles = walk(RENDERER_DIR, ['.tsx', '.jsx']);
  for (const filePath of tsxFiles) {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const rel = relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');

    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      // a11y: 图标按钮无文本缺失 aria-label
      if (
        /<button\b(?![^>]*\b(aria-label|title)=)[^>]*>\s*<[A-Z][a-zA-Z0-9]+ size=\{/i.test(line)
      ) {
        findings.push({
          file: rel,
          line: lineNum,
          rule: 'a11y/button-accessible-name',
          severity: 'warn',
          msg: '图标按钮缺失 aria-label 或 title',
        });
      }
      // a11y: div/span 绑定 onClick 却未声明 role
      if (/<(div|span)\b(?![^>]*\brole=)[^>]*\bonClick=/i.test(line)) {
        findings.push({
          file: rel,
          line: lineNum,
          rule: 'a11y/interactive-role',
          severity: 'warn',
          msg: '非原生交互元素绑定 onClick 需配置 role="button" 与 tabIndex',
        });
      }
      // 防御性工程杂音
      const jargons = ['合成数据验证', '失败 · 不自动重试', '未进入真实班级业务'];
      for (const j of jargons) {
        if (line.includes(j)) {
          findings.push({
            file: rel,
            line: lineNum,
            rule: 'ux/defensive-jargon-leak',
            severity: 'error',
            msg: `生产界面暴露底层工程说明文字: "${j}"`,
          });
        }
      }
    });
  }

  const cssFiles = walk(RENDERER_DIR, ['.css']);
  for (const filePath of cssFiles) {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const rel = relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');

    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      if (
        /outline:\s*none\b/i.test(line) &&
        !line.includes('box-shadow') &&
        !content.includes(':focus-visible')
      ) {
        findings.push({
          file: rel,
          line: lineNum,
          rule: 'a11y/no-outline-removal',
          severity: 'warn',
          msg: '移除 outline 需提供清晰的 :focus-visible 外发光环',
        });
      }
    });
  }

  if (findings.length === 0) {
    console.log('✅ 完美通过！未发现阻碍发布的 a11y 或视觉噪音缺陷。');
  } else {
    findings.forEach((f) => {
      const icon = f.severity === 'error' ? '❌' : '⚠️';
      console.log(`${f.file}:${f.line} - ${icon} [${f.rule}] ${f.msg}`);
    });
    console.log(`\n总计检出 ${findings.length} 条建议。`);
  }
}

function runSearch(query) {
  console.log(`🔍 检索 UI/UX Pro Max 风格与设计系统决策: "${query}"\n`);
  const matched = searchStyles(query);
  if (!matched.length) {
    console.log('未找到直接匹配的风格，展示基础设计系统：\n');
    console.log(JSON.stringify(styles[0], null, 2));
    return;
  }
  matched.slice(0, 3).forEach((s) => {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📌 风格 ID: ${s.id}`);
    console.log(`🏷️  名称:   ${s.name}`);
    console.log(`🎨 主配色: ${s.primaryColors}`);
    console.log(`✨ 强调色: ${s.accentColor}`);
    console.log(`🎯 最佳场景: ${s.bestFor}`);
    console.log(`🚫 避免场景: ${s.avoidFor}`);
    console.log(`📝 检查清单:`);
    s.checklist.forEach((c) => console.log(`   - ${c}`));
  });
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

function runHelp() {
  printBanner();
  console.log(`使用方法 (Usage):
  node tools/frontend-skills-toolbox/bin/fe-toolbox.mjs <command> [arguments]

可用指令 (Commands):
  audit                 对当前项目 (src/renderer) 运行 Web Guidelines 审查
  search <query>        检索 UI/UX Pro Max 风格与配色决策 (如 "education", "bento")
  colors                查看预设的行业与教育配色体系
  ux [keyword]          查询 119 条 UX 交互规范与避坑原则
  tailwind              快速打印 Tailwind v4+ 核心架构与红线禁忌
  vue                   列出已解耦收录的 Vue 3 核心工程指南
  help                  显示此帮助界面
`);
}

switch (command) {
  case 'audit':
    runAudit();
    break;
  case 'search':
    runSearch(args.slice(1).join(' ') || 'education');
    break;
  case 'colors':
    console.log(JSON.stringify(colors, null, 2));
    break;
  case 'ux':
    console.log(JSON.stringify(searchUx(args.slice(1).join(' ')), null, 2));
    break;
  case 'tailwind': {
    const twPath = join(TOOLBOX_ROOT, 'styling/tailwindcss/SKILL.md');
    console.log(readFileSync(twPath, 'utf8'));
    break;
  }
  case 'vue':
    console.log(`
已收录的 Vue 3 工程指南 (位于 tools/frontend-skills-toolbox/frameworks/vue-skills/):
- vue-debug-guides.md         (响应式丢失/生命周期/异步报错排查)
- vue-options-api-best-practices.md (Options API 与 TypeScript 严格规范)
- vue-jsx-best-practices.md   (Vue JSX 与 React JSX 核心语法差异)
- vue-pinia-best-practices.md (Pinia Setup Store 与 storeToRefs 规范)
- vue-router-best-practices.md (Vue Router 4 导航守卫与路由复用)
- vue-testing-best-practices.md (Vitest + Vue Test Utils 黑盒交互测试)
`);
    break;
  case 'help':
  default:
    runHelp();
    break;
}
