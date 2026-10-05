# 工单 07 冻结交付

日期：2026-09-30。按用户要求，先交付冻结至 07 的可安装版本，不继续实施 08。

## 产物

- 安装目录：`release/ticket07-20260930/`。
- 推荐入口：`Install.cmd`，与 `Class-Manager-0.1.0-ticket07-x64-Setup.exe` 放在同一目录。
- 转交压缩包：`release/Class-Manager-0.1.0-ticket07-Windows-x64.zip`。
- 安装与升级说明：`release/ticket07-20260930/README.md`。
- 版本：0.1.0；Schema：5；未签名。独立文件名标识工单 07，不改变冻结程序内部版本。

沿用已存在的 NSIS 安装包，未运行当前源码构建。安装器 SHA-256 为 `db780629f3a2fe0dfc5b0f0f78614c4fd2bc52b104cf96ed9861fea5de59cc4f`，大小 120400261 字节。

## 本轮验证

1. `rtk node scripts/verify-frozen07-release.mjs` 通过：解包 NSIS，73 个程序文件与 `output/release-audit07/win-unpacked` 逐项一致；EXE/ASAR 身份与 07 验收矩阵一致。脚本更新清单与校验文件，不重新生成程序或安装器。
2. `rtk cmd /d /c release\ticket07-20260930\Install.cmd --check` 通过：实际安装器成功复制且逐字节校验，独立临时目录可写。未启动安装向导。
3. 从本次解包目录复制到 C 盘唯一测试目录，再次逐文件校验，通过 `scripts/desktop-smoke.mjs --packaged`。独立合成数据，禁止真实模型网络调用，10 次重开、名册、备份恢复、成绩、解释、座位和值日回归通过，`errors: []`。报告时间为 `2026-09-30T13:49:13.208Z`（北京时间 21:49:13）。

证据：`evidence/07-frozen-release-manifest.json`、`evidence/07-frozen-release-desktop-report.json`。此前 07 的打印、PDF、全仓测试及视觉证据仍见 `duty-acceptance.md`，本轮不冒称重新执行这些检查。

本轮未安装或卸载应用、未更改用户配置和数据、未发起付费调用。目标机安装生命周期、实体出纸和非技术用户独立接手仍待验收。本交付不代表 08–15 完成，不修改现有源码或回退工作区。
