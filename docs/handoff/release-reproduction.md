# 第15号证据复跑条件

交付候选的`source/`提供当前源码、完整锁文件、fixture、构建配置与手册。在锁定Node24.14.x及Windows x64环境运行`npm ci`、`npm run check`、`npm run dist:win`可以重建当前源码、执行规则/应用测试并打包。依赖下载需要网络；并非接收人使用安装版的运行依赖。安装器与运行包的最终身份以交付manifest及15包清单为准。

实际桌面验收依赖所选打包程序和合成数据目录。15的包装脚本`output/run-15.cjs`、`output/run-15-ui.cjs`是本机审计工具，源文件副本位于交付`evidence/15/tools`，包含执行时绝对路径；换电脑时须先校验新包并显式替换这些路径。不能把这些脚本直接复制运行当成跨电脑的无人值守安装方案。

## 许可整改新候选

本轮包装器为`output/run-15-license.cjs`，从新C盘manifest选择已经逐文件核验的83文件程序，分别设置通用、备课/Office/课堂、批改、入分、成长、供应商、对话、设备及长时脚本的EXE参数。各业务脚本仍自行创建合成数据目录。包装器使用wx日志，不覆盖原候选证据；它不是新的业务接口，也不发送真实模型请求。

安装脚本新增`CLASS_MANAGER_RELEASE_MANIFEST`和`CLASS_MANAGER_INSTALLATION_AUDIT_OUTPUT`，本轮选择`output/15-license-installation-manifest.json`与`output/playwright/installation15-license`。新manifest的独立验收安装器为`output/release-audit15-license-isolated/Class-Manager-0.1.0-x64-Setup.exe`，仍使用`local.classmanager.acceptance15`、关闭快捷方式，83文件负载与本轮正式appId构建输入一致。不设置上述环境变量时，脚本保持原候选路径；不能因此把默认路径复跑记为新包通过。

守卫脚本可通过`CLASS_MANAGER_RELEASE_GUARDS_REPORT`选择新报告文件；新包装器设置`output/15-license-guards-report.json`。真实长时脚本依然强制显式EXE、单调时钟至少一小时、真实重开与强杀、关闭成功后发布passed。新运行源、包装退出、独立进程身份和终态由`output/15-license-stability-*.json`分别绑定；历史日志不能作为该新包的通过证据。

这些工具源副本会随新归档保留，运行路径仍为本机审计时路径。换电脑须重新校验EXE、补齐下方旧07材料及已有安装前置条件，不允许只改一项路径后宣称历史迁移已跨电脑复现。新候选独立用户演练使用[新演练说明](user-acceptance15-license.md)，与原候选目录分开。

## 安装迁移复验

本次普通用户安装、旧v5→v11迁移、旧/新备份恢复和卸载结果已保存。要复跑`scripts/release-installation-smoke.mjs`，还需要原仓库保留的下列材料及本机既有安装环境，这些没有进入本次便携源码ZIP：

- `release/ticket07-20260930/manifest.json`及其指向的73文件冻结运行包；按manifest逐项校验，不能用当前包替代旧版。
- `output/release-audit15-old-isolated/Class-Manager-0.1.0-x64-Setup.exe`，旧隔离安装器SHA256为`0ccd32d7ebdf3c179692068732f995ea66550d650cba13108e3aa4f119cda2d3`。
- `output/release-audit15-isolated/Class-Manager-0.1.0-x64-Setup.exe`及15包manifest；这是独立`local.classmanager.acceptance15`注册命名空间，不是正式appId覆盖安装。
- 脚本当前用于前后核对的本机既有`Programs/Class Manager`安装。其他电脑须先调整前置验证，并保留对应修改/身份记录，不能虚构已存在旧安装。

上述文件在本机工作区保留，没有清理或重建冻结07。具备前置条件后，先关闭全部Class Manager窗口，再从原仓库运行`node scripts/release-installation-smoke.mjs`。运行前查询必须成功且实例数为0；不得与60分钟测试或其他客户端使用并行执行。查询错误也会拒绝启动安装器。真实生命周期会安装和卸载独立验收注册项，仅使用脚本新建的合成目录。

因此，交付ZIP可独立重建当前软件并运行其规则/应用测试；历史迁移验收的完整复跑仍依赖上述保留材料及环境，尚未实现跨电脑独立复跑。已通过的原始迁移证据不因这一限制失效，也不补签“干净Windows已通过”。真实模型脚本另需新的单次付费授权与本地凭据，不随`npm run check`或源码交付自动执行。
