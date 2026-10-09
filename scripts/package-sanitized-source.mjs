import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import ts from 'typescript';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const personalNames = [
  ...new Set([process.env.USERNAME, path.basename(process.env.USERPROFILE ?? '')]),
].filter((name) => name && name.length > 2);
const personalPattern = new RegExp(
  personalNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'gi',
);
const git = (args) => {
  const result = spawnSync('rtk', ['proxy', 'git', ...args], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, 'Cannot read repository inventory');
  return result.stdout.toString('utf8');
};
const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date())
    .map(({ type, value }) => [type, value]),
);
const stamp = `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
const destination = await fs.mkdtemp(
  path.join(process.env.USERPROFILE, 'ClassManagerDeliveries', `Source-${stamp}-`),
);
const label = `Class-Manager-Source-Sanitized-${stamp}`;
const fixtures = ['tests/fixtures/frozen-v7.sqlite', 'tests/fixtures/frozen-v6-lessons.sqlite'];
const rootFiles = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.gitignore',
  'README.md',
  'CONTEXT.md',
];
const excluded =
  /(?:^|\/)(?:asset|output|dist|release|node_modules|evidence|\.git|\.local-data|coverage|credentials|conversation-history|workspace-data)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:log|cmbackup|db|pem|p12|pfx|key|sqlite(?:-.*)?)$/i;
const files = git(['ls-files', '--cached', '-z'])
  .split('\0')
  .filter(Boolean)
  .filter(
    (file) =>
      (rootFiles.includes(file) || /^(?:src|scripts|tests|tools|docs|\.github)\//.test(file)) &&
      (!excluded.test(file) || fixtures.includes(file)) &&
      !/^docs\/.*\.(?:png|jpe?g|gif|webp|pdf|docx|pptx|xlsx|zip)$/i.test(file),
  )
  .sort();
assert.ok(
  files.includes('src/main/main.ts') && files.includes('src/shared/resource-library/catalog.json'),
);
const manifest = [],
  redactions = [],
  archive = new JSZip();
const credentialPattern =
  /\bsk-[A-Za-z0-9_-]{16,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/g;
const syntheticCredential =
  /^sk-(?:synthetic[-_]|test[-_]|sample[-_]|account-[ab]-|real-secret-token-abcdef$|1234567890abcdef$)/;
const textTypes =
  /\.(?:ts|tsx|js|mjs|cjs|json|css|html|md|txt|svg|mmd|yml|yaml|cmd|bat|sh|ps1|py|cs|toml|csv)$/i;
for (const file of files) {
  assert.ok(!(await fs.lstat(file)).isSymbolicLink(), `Source link excluded: ${file}`);
  let bytes = await fs.readFile(file);
  if (fixtures.includes(file)) {
    const description = await fs.readFile(file.replace(/\.sqlite$/, '.md'), 'utf8');
    assert.equal(
      hash(bytes),
      /SHA-256[^a-f0-9]*`?([a-f0-9]{64})/i.exec(description)?.[1],
      `Frozen fixture changed: ${file}`,
    );
    assert.match(description, /合成|虚构/);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS n FROM students').get().n),
        0,
        `Unexpected student fixture: ${file}`,
      );
    } finally {
      db.close();
    }
  } else if (textTypes.test(file) || file === '.gitignore') {
    const original = bytes.toString('utf8');
    const candidates = [...original.matchAll(credentialPattern)].map((m) => m[0]);
    assert.ok(
      candidates.every(
        (value) => /^(?:tests|scripts)\//.test(file) && syntheticCredential.test(value),
      ),
      `Review credential-shaped literal; values withheld: ${file}`,
    );
    let text = original
      .replace(/([A-Z]:[\\/]+Users[\\/]+)([^\\/\s"'`<>:]+)/g, '$1USER')
      .replace(personalPattern, 'USER')
      .replace(/wxid_[A-Za-z0-9_]+/g, 'WECHAT_ID_REDACTED')
      .replace(/H:[\\/]+WorkSpace[\\/]+class-manager/gi, (match) => {
        const separator = match.includes('\\\\') ? '\\\\' : match.includes('\\') ? '\\' : '/';
        return `C:${separator}Workspace${separator}class-manager`;
      });
    if (/^docs\//.test(file))
      text = text.replace(
        /https:\/\/(?:www\.)?workbuddy\.(?:link|cn)\/(?:p|space\/d)\/[A-Za-z0-9_-]+/g,
        'https://example.invalid/customer-design',
      );
    assert.ok(
      !personalPattern.test(text) && !/wxid_[A-Za-z0-9_]{6,}/i.test(text),
      `Personal identifier remains: ${file}`,
    );
    if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(file)) {
      const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      assert.equal(parsed.parseDiagnostics.length, 0, `Sanitized source syntax: ${file}`);
    } else if (/\.json$/.test(file)) JSON.parse(text);
    if (text !== original) redactions.push(file);
    bytes = Buffer.from(text, 'utf8');
  } else {
    assert.ok(
      /^src\//.test(file) || /(?:LICENSE|NOTICE|COPYING)/i.test(file),
      `Unreviewed binary file: ${file}`,
    );
  }
  archive.file(`${label}/${file}`, bytes);
  manifest.push({ file, bytes: bytes.length, sha256: hash(bytes) });
}
const readme = `# 脱敏源码交付说明\n\n本包为当前班级助手源码的独立交付副本，原工作区与客户数据未被修改。保留应用源码、构建脚本、测试、依赖锁文件和文字文档。\n\n排除竞品 asset、Git 历史、已安装依赖、构建产物、数据库运行数据、日志、备份、凭据、历史验收截图与执行证据。个人 Windows 用户名、开发者工作区路径和微信标识已替换；客户共享设计链接已遮蔽。\n\n测试中的合成密钥与虚构学生资料用于验证保护逻辑，不是真实账号。仅保留两份经固定哈希校验的合成数据库迁移夹具；其中没有学生记录。\n\n开发环境：Windows x64，Node.js 24.14 或兼容的 24.x。先运行 npm ci，再运行 npm run typecheck、npm run lint、npm test、npm run build；启动开发程序使用 npm run dev。历史文档的 rtk 前缀为开发者命令代理，可去掉。\n\n原免安装打包脚本需要另行生成 Word 文档和诊断输出；这些运行产物不属于本源码包。基础应用构建不依赖它们。\n\n每个文件的 SHA-256 见 source-manifest.json。脱敏详情见 sanitization-report.json。本包未配置任何可用模型账号。\n`;
archive.file(`${label}/脱敏交付说明.md`, readme);
archive.file(`${label}/source-manifest.json`, JSON.stringify(manifest, null, 2));
const report = {
  status: 'passed',
  createdAt: new Date().toISOString(),
  baseCommit: git(['rev-parse', 'HEAD']).trim(),
  includedFiles: files.length,
  redactedFiles: redactions,
  syntheticDatabaseFixtures: fixtures,
  credentialsFound: 0,
  excluded: [
    'asset',
    '.git',
    'output',
    'dist',
    'release',
    'node_modules',
    'runtime data',
    'logs',
    'credentials',
    'historical execution evidence',
    'document binaries',
  ],
};
archive.file(`${label}/sanitization-report.json`, JSON.stringify(report, null, 2));
const zipped = await archive.generateAsync({
  type: 'nodebuffer',
  platform: 'DOS',
  compression: 'DEFLATE',
  compressionOptions: { level: 6 },
});
const reopened = await JSZip.loadAsync(zipped, { checkCRC32: true });
for (const item of manifest)
  assert.equal(
    hash(await reopened.file(`${label}/${item.file}`).async('nodebuffer')),
    item.sha256,
    `ZIP content differs: ${item.file}`,
  );
const zip = path.join(destination, `${label}.zip`);
await fs.writeFile(zip, zipped, { flag: 'wx' });
await fs.writeFile(zip + '.sha256', `${hash(zipped)}  ${path.basename(zip)}\n`, { flag: 'wx' });
await fs.writeFile(
  'output/current-sanitized-source.json',
  JSON.stringify(
    {
      ...report,
      zip,
      bytes: zipped.length,
      sha256: hash(zipped),
      crcVerified: true,
      allFileHashesVerified: true,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    status: report.status,
    zip,
    files: files.length,
    redactedFiles: redactions.length,
    bytes: zipped.length,
    sha256: hash(zipped),
  }),
);
