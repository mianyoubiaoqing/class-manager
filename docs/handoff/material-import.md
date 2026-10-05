# 08 资料解析阶段交接

更新：2026-10-01。范围是资料解析与独立处理进程，属于工单 08 的内部阶段，不是整单验收。07 冻结安装包保持不变。

后续存储阶段已完成：资料原件/PNG、备课草案与冻结修订纳入 Schema 6 及备份；680 项全仓检查、实际 Electron 运行时与双轴复审通过。详见 [存储阶段交接](lesson-storage.md)。以下解析阶段的“尚未修改 Schema”仅为当时记录。

最新接续：TXT/DOCX/PNG/JPG/PDF 内部解析现已接入同一可取消进程。PDF 文本、整页 PNG 与页码均保留；扫描页不声称已经 OCR。所有 PDF 标为 partial，教师必须对照并确认范围。当前继续核对打包原生依赖与资料/备课存储；教师页面、持久化、模型编排尚未完成。

## 实现

- `src/core/material-docx.ts`：使用现有 yauzl/Saxes 提取 DOCX 正文段落和 PNG/JPG 内嵌图片字节。校验 ZIP 本地文件名与中央目录一致、重复/加密/链接条目、CRC、内部引用、内容类型、XML 命名空间及主文档身份。宏、活动控件、嵌入程序、DTD、外部模板/图片、损坏及超限输入全部拒绝，不返回成功前缀。
- 段落定位包含空段落，文本和图片保持正文先后顺序。表格暂按段落提取；自动编号、字段缓存、特殊符号、样式继承、页眉脚注、公式、图表、文本框和兼容绘图等不能完整还原时明确为 partial 并保留警告。超链接只提取标签，不访问目标。不是 Word 排版引擎；原文预览及教师对照页面尚未实现。
- `src/core/material-image.ts`：固定 Sharp 0.35.5，完整解码 PNG/JPG、应用 EXIF 方向、保留透明度，转为不带原元数据的静态 PNG。拒绝格式伪装、损坏/截断、超像素、动画 PNG。没有 OCR 或模型识别。
- `src/core/material-parser.ts`：组合 TXT/DOCX/PNG/JPG/PDF 为严格资料版本和独立资产。原文件与标准化图片分别分配身份及哈希；只有所选片段进入后续备课准备。PDF 生成的受限页面 PNG 直接登记，不把派生图错误当作受 10 MiB 上传限制的原文件再次解码。
- `src/core/material-pdf.ts`：PDF.js 6.3.289 + @napi-rs/canvas 1.0.9 按页提取文字和渲染。最多 20 页，108 dpi（比例 1.5），每画布/嵌入图像 2000 万像素，累计页画布 1 亿像素；每页文本最多 50000 项，累计 200000 字符。原文件和每页图像留作对照，空白/扫描/混合页都保留；文字按最多 8000 字符切片并保留页码。拒绝密码保护、脚本、表单、嵌入附件、损坏及超限。字体/CMap/WASM 仅从锁定依赖内的文件名单读取，不接受资料指定路径、URL 或外发。所有 PDF 为 partial，文字顺序及语义不保证正确，模型处理范围仍须教师选择。
- PDF.js 某些图像错误仅发警告后丢弃图像，因此独立任务内捕获它的 Warning 诊断并拒绝整份结果，不记录原诊断正文；成功/失败后恢复 console.warn，并禁止同进程并发 PDF。JavaScript 及外链均不执行。
- `src/main/material-process.ts` 与 `material-task.ts`：一次一个可终止子进程，30 秒默认时限、256 MiB JS 堆上限、环境变量白名单、进程间严格结构和来源/资产哈希复核。取消或超时终止进程，等待 close 后才释放任务槽；迟到成功不覆盖取消，没有自动重试。进程关闭不存资料，应用重启不会继续请求。
- 构建脚本新增 `material-process.cjs`，Sharp 保留为外部原生依赖。当前 Main 尚未实例化该服务，没有新增 Renderer IPC 或教师页面，亦未修改 Schema/备份协议。

## 限制与边界

原文件最多 10 MiB。DOCX 最多 256 个 ZIP 条目，单条目 8 MiB，累计解压 32 MiB，XML 100000 个节点、64 层；重复图片引用累计最多 32 MiB。正文仍遵守 200000 字符、单片段 8000 字符、500 片段。

单图最多 2000 万像素；标准化单图 32 MiB、单份资料图片合计 64 MiB。限额是拒绝边界，不是全部上限同时满载的性能承诺。派生图片可能比原文件大，下一阶段必须同步升级现有附件、备份和存储限制，不能直接塞入 M0 的单附件 1 MiB 容器。

进程隔离不是操作系统权限沙箱；JS 堆限制不是原生库 RSS 硬限制。生产接入时仍需保持单任务准入、取消/关闭清理，并验证 Electron Node 子进程、打包 ASAR 原生依赖和目标机内存。子进程不读取凭据、用户数据库或配置，不发起模型请求。

## 检查与自审

2026-10-01 本次接续基线：`npm run check` 610 项、格式/类型/Lint/构建通过，日志 `output/08-current-baseline-check.log`。PDF 首轮有五项失败：测试文字超出真实页面、指数数字样本无效、超限嵌入图被静默删除等。修正为页面内文字样本后，定位到 PDF.js 的 operator stream 出错时先 resolve 再 reject，添加下述补丁；PDF/图片/任务专项 35 项通过。全仓阶段检查为 623 项，日志 `output/08-pdf-stage-check.log`。

Standards/Spec 并行只读自审（仅本 PDF 内部阶段）发现：原公共注释和交接称无渲染/不支持 PDF；新依赖分发说明缺失；零/负图像尺寸只有 worker 警告却成功返回。已修正注释，补本说明，并新增零/负尺寸、并发及警告清理三项回归。修复后 PDF/图片/任务专项 38 项通过；最后全仓及打包复验待记录，不把 623 项旧结果当作这次修复后的全仓证据。

开发 Electron 44.4.5 的 Node 24.21.0 中实际 fork 资料进程，TXT/PNG/PDF 连续处理通过；报告 `output/material-runtime/run-r7XTDm/report.json`。这是原生进程/解码器检查，不是教师界面或安装生命周期验收，且发生在警告保护补强之前。三页合成文本/扫描/混合样本和 PNG 位于 `output/pdf/material08/`，已实际查看三张渲染图，图像与文字可读。

## 新依赖与可复现补丁

- PDF.js（`pdfjs-dist` 6.3.289）：Apache-2.0；保留分发 LICENSE、字体、CMap、WASM、legacy 主模块和 worker 模块。参考 [官方 Node 页渲染示例](https://github.com/mozilla/pdf.js/blob/master/examples/node/pdf2png/pdf2png.mjs)；具体 API 以安装的锁定源码为准。
- @napi-rs/canvas 1.0.9：MIT；Windows x64 MSVC 原生模块必须随应用分发并在 ASAR 外保留可加载的二进制。Skia 及所带第三方组件的 NOTICE/许可证随依赖保留，不把 npm 包许可证扩大为所有第三方组件许可。参考 [官方仓库](https://github.com/Brooooooklyn/canvas)。
- `scripts/patch-pdfjs.mjs` 修复锁定版本的 operator stream 错误先完成后拒绝：先拒绝公开读取 Promise，再通知完成回调。postinstall 与 build 均验证并应用；版本必须为 6.3.289，两个原始分发模块 SHA-256 必须匹配，重复执行不重复修改。未知版本或外部修改立即失败。升级 PDF.js 须重新审查该修复并重跑坏图回归，不能删除补丁后沿用旧验收。
- esbuild 将 PDF.js 和 canvas 保留为外部运行时依赖，不将 ESM worker 拼入 CJS 或把原生模块塞入 Renderer。当前独立 `output/release-audit08-material/` 仅为阶段打包候选，不能覆盖 `release/ticket07-20260930/`，也不能声称含完整备课页面。

## PDF 阶段最终闭环（2026-10-01）

警告保护修复后，完整 `npm run check` 626 项、格式/类型/Lint/构建通过，日志 `output/08-pdf-final-check.log`。Standards 两项文档发现与 Spec 一项坏图发现均已修复；两路复审无剩余代码发现，旧“无子代理”文字已明确为上一阶段历史。结论限于 PDF 内部阶段，08 整单未通过。

当前源码重新独立打包到 `output/release-audit08-material/win-unpacked`，C 盘副本为 `C:\Users\flow032417\AppData\Local\class-manager-material08-uC2DXF`。源与副本 EXE SHA-256 均为 `696b350f6ecd9e2b7c6f77c6c15e4f0c5b5f6071697e81e5c777a9b139b4dd1f`，ASAR 均为 `e203ca70a163bf860ef9991f189c96ea84f0cb34c1dcb4ccc4944e19068ac7fa`。实际打包 EXE 的 Node 模式 fork **该 ASAR 内**的 `dist/main/material-process.cjs`，TXT、PNG、PDF 页和坏 PDF 图像拒绝、连续任务均通过。此追加运行时用例后类型检查通过；不是通过开发目录解析器冒充 ASAR 依赖验证。

最终打包报告 `evidence/08-material-packaged-runtime.json`，开发报告 `evidence/08-material-development-runtime.json`；三张已查看图及自制 PDF 为 `evidence/08-material-pdf-page-{1,2,3}.png`、`08-material-synthetic-original.pdf`。最终重新读取冻结 07 安装器/启动器，SHA-256 与其清单一致，未重建覆盖冻结目录。未访问用户学生数据或凭据，没有真实模型请求、安装或教师页面验收。

下一阶段仅继续 08：资料资产与备课草案/冻结版本持久化、Schema 6 及旧版备份兼容。现有单附件 1 MiB、总计 12 MiB 限制必须按新版协议一起升级，并对旧 v1–v5 保留原来的严格资源边界；不能直接扩大旧协议校验。

接续基线：先因 `scripts/verify-frozen07-release.mjs` 格式未规范停止，格式化后 `npm run check` 通过，550 项测试，测试耗时 138.19 秒；日志 `output/08-resume-baseline-check.log`。只格式化脚本，没有改变已交付安装包。

DOCX 第一轮 31 项通过。自审新增六项测试先全部失败：重复图片内存放大、三类 XML 嵌套伪造、公式遗漏仍标完整、显式关闭隐藏属性误判。修复后 DOCX 37 项与原备课 39 项合计 76 项通过。巨型图片断言后来只报告摘要，避免失败时倾倒数十 MiB 二进制。

图片 8 项验证真实解码、透明度、方向、去元数据、像素超限、动画拒绝、原文件独立和 DOCX 图文整合。独立进程首轮 13 项验证真实 PNG 解码、取消/超时/关闭、崩溃、错误结构和哈希、孤立/重复资产、环境秘密不继承。合计 97 项通过。之后又补原文件 MIME 复核及一次哈希复用；最终回归结果待实际命令结束后记录，不沿用前一轮计数。

上一解析阶段的 Standards 自审历史范围：以上新增文件、共享资料常量、构建配置、锁文件及测试；对照 `8026afa52ca58c1bf1750662017f32c70e88fbd4` 与当时接续前现状，不回退 03–08 的既有未提交工作。当时没有可用子代理工具，由同一执行者分别检查两个轴线，不声称该历史审计独立并行；2026-10-01 PDF 阶段使用了两路只读子代理。

Spec 自审仅接受本阶段内部解析能力。尚缺完整对照预览、资料与备课持久化、升级及备份、模型编排、教师界面和开发/打包端到端验收。不得勾选 08 整单完成，不进入 09。

## 下一步

1. 完成 PDF 警告保护后的全仓检查、原生运行时和打包 ASAR 复验并关闭阶段自审项。
2. 验证 Electron 和打包环境的原生解码器及子进程，保留 07 独立冻结安装目录。
3. 设计并实现资料资产和备课版本持久化、Schema 迁移及备份兼容，落实全部新资源上限。
4. Main 本地文件选择、只读受限预览、教师明确选择资料与外发范围，再接模型编排和编辑历史页面。真实付费请求仍需用户单独授权。
