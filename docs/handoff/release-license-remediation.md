# 第15号许可缺项移除：软件验证通过，交接待验收

2026-10-02，许可修复的新候选软件验证已通过，外部/接收人交接尚未验收。原`ticket15-20261002-candidate`、ZIP、审查副本、60分钟报告及16/17冻结差异保持原字节；它们证明原候选，不用来冒充新包验证。

[一手来源调查](release-license-research.md)未找到能够绑定原四个确切版本的完整通知。采取实际移除的技术修复：将ExcelJS的unzipper明确override到已有锁定版本0.12.5；从Windows运行包排除只有元数据的npm https目录。PptxGenJS明确使用`node:https`。新unzipper自身许可与确切npm gitHead逐字节一致，接口静态匹配仅作实施依据；新包仍须跑实际XLSX、Office、完整回归、安装及稳定性验收。

初次npm install保留了与override冲突的旧嵌套锁记录；该阶段全仓结果保留但不计作替换后通过。原锁记录另存`output/15-license-lock-before-reconcile.json`；仅移除两个过期的嵌套unzipper锁条目，再由npm重新解析，干净npm ci成功。重新解析没有升级任何保留包的version/integrity，移除了11个旧闭包条目；详情为`output/15-license-lock-reconciliation.json`。新npm图由`npm ls`实际核验，新回归结果待收齐。

`https`在构建依赖声明中仍存在，不能把它的空源码或未运行解释成完整许可；只有实际打包清单确认它没有进入新运行包后，才记录新包的分发清单已移除。原通知缺项记录不回填，也不推断源代码项目已经变成开源许可。

当前电脑有Hyper-V模块，但实际Get-VM被授权策略拒绝；Windows Sandbox程序不存在。未更改权限、启用系统组件或尝试绕过该限制。证据为`output/15-clean-environment-query.log`。仍需可用的干净Windows环境，等待用户已发出的环境信息问题答复。

替换后的首轮实际全仓回归失败：unzipper0.12.5的可选S3入口要求@aws-sdk/client-s3，esbuild提前解析未安装模块，57项测试不能构建、32项跳过；不是用绿测试掩盖。完整失败日志为output/15-license-reconciled-check.log。失败后已核查同系列确切版本并排除直接回退；已实施共享Node构建策略，不添加应用未要求的AWS依赖。新的全仓检查退出0：格式、类型、Lint、58个测试文件的1004项测试及构建全部通过，日志为`output/15-license-bundle-policy-check.log`。此结果证明源码检查，新运行包验收仍待完成。

0.12.3与0.12.4的固定npm源及隔离构建同样含该可选SDK入口，回退不能解决。当前继续0.12.5，scripts/node-bundle-options.ts为Node构建统一保留@aws-sdk/client-s3为外部模块；36个既有Node构建调用使用同一选项。该边界不修改unzipper源码，不加载S3服务，也不把S3列为交付能力。

## 新候选实际证据

新构建位于`output/release-audit15-license`。83个运行文件与独立验收appId包、C盘副本逐字节一致，19个dist文件与ASAR一致；四个问题依赖的包条目及source map来源均已移除。实际运行依赖109项、通知109份、缺项0；Electron和Chromium通知另附。补充通知只沿用相同name/version且原字节哈希匹配的历史确切版本原文。新包仍按项目`UNLICENSED`交接，不自动产生源项目开源或再分发授权。

正式appId安装器145888412字节，SHA256为`abfa56d143869715688951129cde8cafa8810f2525d832cd4c411315425347bc`。独立验收安装器禁用快捷方式，以相同83文件负载完成普通用户安装、旧07的v5数据升级到v11、100名学生及附件保持、旧备份恢复、新备份、卸载保留数据；既有正式安装的EXE/ASAR未变化。安装器不会与长时测试并行运行。详见`output/15-license-installation-manifest.json`及`output/15-license-installation.log`。

新源码最终全仓检查为`output/15-license-final-source-check.log`：58文件/1004项、格式、类型、Lint和构建全部通过。通用10次重开、备课、Office实际导出、课堂、答卷建议、正式入分、成长、三供应商设置、统一对话、外设页面均在该C盘新包通过；19项构建哈希在全仓重建后再次一致，记录为`output/15-license-before-stability.json`。这些流程的模型传输为合成替身，本轮真实外部请求0。

成长回归最初三次完整脚本在立即读取导航状态时失败；保留全部报告。完整诊断探针记录：学生选择先禁用，导航下一帧禁用并保持。缩减探针的150次输入/取消均通过，说明缩减会改变时序，不能用它代替原失败。验收脚本现等待学生选择和导航两端均完成锁定/释放，然后仍断言每个非正文字段阻止离开；原完整脚本修复后通过，最新全脚本格式通过。产品UI源码未改动。证据为`output/15-license-growth-navigation-full-probe.log`及`output/15-license-growth-navigation-fixed.log`；临时探针只保留在明确的output诊断位置。

新60分钟测试于2026-10-02 17:20:27（UTC+8）启动，运行根为output/playwright/stability15/run-Dx3OR7；实际持续3601393ms，353轮、11正常重开及1真实强杀重开，60合成故障、60确认成长事实，错误0。执行源冻结为output/15-license-stability-running-source.mjs，SHA256为c828b5e72f9083ef6be3ddf0f83e8cafe166446c2405e1e69c829fb60816dbb9，先关闭成功再发布passed；父包装退出0，独立观察569快照/54个PID+创建时间身份，最终候选路径及已观察身份均无残留。60份资源样本合计工作集464652–495320 KiB，是本机观测区间。终态绑定报告、冻结源、启动记录、包装与进程证明；第一段观察因PowerShell日期格式修正而保留并重启观察器，应用和60分钟计时没有重启，不声称每个早期PID均由最终观察器覆盖。

构建前后全部成功及失败日志、新旧候选和历史许可调查保持独立。ASAR扫描第一次把`hash.js`目录误当文本文件，原通知副本已保留；现按实际ASAR元数据跳过目录/链接，扫描新包文本未发现明文Key形状。该形状扫描不证明所有格式的秘密均不存在。汇总校验器第一次因阅卷脚本使用文字成功标记而误报失败，已按真实日志格式修正；实际阅卷包装退出0和完整报告保留。工具修正见`output/15-license-audit-tool-corrections.json`，不回填历史报告。

新交付只包含许可调查的文档、捕获manifest、哈希及验证结果，不复制调查下载的tarball或解包源码；四个原问题组件不因调查证据而重新进入交付。完整184项本地调查材料继续保留，摘要中的原路径指向本地材料，便携归档不声称附带所有HTTP原始响应。新包的109份运行依赖通知原文实际随交付保留。

组装工具预审发现三项需要补齐的证据门槛：不能只信通知计数；安装/UI汇总须与当前EXE/ASAR相同；启动记录、执行源、报告路径、退出证明与包装时间须属于同次运行。现共享校验器逐项核对109个依赖的name/version/许可、通知路径/字节/SHA256及实际ASAR原文或历史确切版本补充；Electron/Chromium通知绑定运行文件哈希，目录只允许113个声明文件，不夹带额外源码。组装按通过的白名单复制。终态与组装均校验启动源哈希、启动/报告/包装/观察时间、确切EXE及报告路径；安装负载与当前manifest完整一致。

18项故障验证已通过，记录为`output/15-license-evidence-gates-report.json`：实际通知与构建身份接受；改坏/移除通知、夹带源码、旧汇总或错误安装身份、错误证明EXE/报告路径/启动源/启动时间、提前退出、短时运行、未确认关闭及残留进程均拒绝。测试只修改新建的合成通知副本，候选通知和真实长时运行未改动；合成通过场景不计作真实60分钟通过。
