# 10 课堂辅助与倒计时验收矩阵

2026-10-01：10 整单通过，Standards/Spec 最终复审均通过，未关闭发现 0。范围为 Windows 合成数据技术验收，接着执行 11；总目标仍须完成 11–15 及 01–02 的遗留环境验收。最终自审见 [课堂自审](classroom-audit.md)。

| 工单要求 | 实现与证据 | 结果 |
| --- | --- | --- |
| 展示窗只取得允许字段和有限操作，不含私有备注、成绩、档案 | 独立 HTML/Preload；仅投影、计时、全屏三个操作，绑定窗口、主 Frame、精确 URL；投影重建字段。开发及打包实际窗口检查管理桥接/Node 不可用，管理 IPC 返回 FORBIDDEN，越界输入被拒绝。`evidence/10-classroom-development/report.json`、`evidence/10-classroom-packaged/report.json`。 | 通过 |
| 环节、暂停恢复和进度可重开，草稿更新不替换当前课 | 引用确切冻结版和所选页序，CAS 控制；同环节保留时间，换环节重置并暂停。实际创建新冻结版后原课堂版本不变；正常退出保存运行时间，进程树强制退出后读取最后持久检查点，重开为暂停/interrupted；恢复关闭展示、暂停进度并拒绝旧 epoch。 | 通过 |
| 开始前确认版本/范围，答案显式选择 | 创建要求 acknowledgeScope；选择变化撤销 UI 确认。默认无答案，明确选择后显示，换页隐藏问题/答案，重新打开也清除旧选择；实际截图验证。创建、开窗后回读失败不会显示虚假控制成功。 | 通过 |
| 可设置日期及时区，跨日、系统时间变化、到期不负数或错年 | Gregorian 日期与 IANA 时区校验、目标时区日历日期差；覆盖北京时间午夜、纽约 DST、闰年、到期、非法日期/时区。主页和展示定时/恢复可见读取。桌面设置 2031-06-07，关闭重开及备份恢复保持目标。`tests/classroom-core.test.ts`。 | 通过 |
| 计时按时间差，隐藏恢复不累计漂移；离线可用 | Worker 单调锚点；高频检查点不重置锚点。模拟系统时间前后跳、持久失败及恢复测试；实际隐藏 2.2 秒后计时差约 2.24 秒。课堂套件配置无凭据，Main fetch 禁用，真实外部请求 0。 | 通过 |

## 整体验证

- 最终 44 个测试文件、742 项测试及格式、类型、Lint、构建通过：`evidence/10-final-check.log`。仅对子进程配置项目 TEMP/TMP，未改变全局环境。
- 开发/打包课堂完整流程、开发/打包长标题与长正文流程均通过，四份报告分别在 `evidence/10-classroom-development/`、`evidence/10-classroom-packaged/`、`evidence/10-long-development/`、`evidence/10-long-packaged/`。长内容在 360×760 视口有 617 像素阅读区，正文末尾可滚动查看。
- 主代理实际查看开发版默认/窄窗口以及打包版显式答案、问题、教师桌面、长标题和正文末尾图件。没有把几何断言当作图像查看。
- 开发与当前打包的完整原有桌面回归均通过，分别包含 10 次重开、名册、隔离、备份/恢复、成绩、解释、座位和值日：`evidence/10-desktop-development/report.json`、`evidence/10-desktop-packaged/report.json`。
- 通用桌面脚本原有接口白名单停留在 07，初次回归因此失败。已明确列入获批准的 08–10 操作，共 79 个管理接口，仍进行精确比较，不动态读取生产清单作为预期值。旧失败保留 `evidence/10-bridge-regression-failure.log`；修复后两套回归通过。
- 新独立解包候选为 `output/release-audit10/win-unpacked`。源与 C 盘测试副本 82 文件逐一 SHA-256 相同，当前 dist 的 13 个运行文件与候选 ASAR 相同：`evidence/10-packaged-runtime.json`。打包课堂测试的应用 PATH 限制为 Windows System32，不依赖安装的开发工具。候选是 Schema 7；09 历史候选仍为 Schema 6。
- 没有重建或覆盖 07 冻结交付，没有更新用户已安装程序或原 NSIS 安装器。完整安装、升级、卸载、目标机及最终交接仍由 15 验收。

## 复验

```powershell
rtk npm run check
rtk node scripts/classroom-ui-smoke.mjs
rtk node scripts/classroom-ui-smoke.mjs --long-titles
rtk npm run test:desktop
```

本机需沿用 `execution-status.md` 的 C 盘 Electron 运行条件及项目 TEMP/TMP；打包课堂使用 `CLASS_MANAGER_LESSON_EXECUTABLE`，通用打包套件使用 `CLASS_MANAGER_PACKAGED_EXECUTABLE` 和 `--packaged`，均指向记录中经校验的候选。复验使用独立合成数据，不读取用户 Key 或调用模型。先完成构建再测桌面，不同时改写同一份 dist。

课堂最多 1000 条、进度载荷 16 KiB、计时 24 小时等均为拒绝边界，不是最大容量性能承诺。正常退出完整保存，强制退出仅恢复最近检查点；物理断电、现场投屏设备及教师真实课堂均未在本单声称通过。
