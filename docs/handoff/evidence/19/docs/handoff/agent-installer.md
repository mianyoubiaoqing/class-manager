# Agent18 安装向导与 NSIS 临时文件错误

2026-10-02。安装包使用18已冻结程序负载，保留原便携ZIP；EXE/ASAR分别为 `635f682e8bb8e4043fad5c2e6f4a387ccef1bb5114366a99de32b42a56d4da64`、`69577cb182bff92a9d2de796a37f896aecf94611dc3a5d256b33d13afea7dae8`。

## 本机安装

最终安装入口位于 `C:\Users\flow032417\AppData\Local\ClassManagerSetup\Agent18-Installer-zqGIFh`。保存并退出正在使用的Class Manager，双击 `Class-Manager-0.1.0-Agent18-x64-Setup.exe`。选择“仅为我安装”，按需更改安装目录。完成后可从桌面或开始菜单启动，主界面默认业务对话、侧栏第一项也是业务对话。模型账号在安装后配置。早期 `Agent18-Installer-Huxp3q` 副本及原说明保留，最终说明明确使用安装器完整文件名，不能将其改名为Setup.exe。

若安装器在H盘仓库中，请双击其旁边的 `Install.cmd`：启动器会新建当前用户的C盘暂存目录，复制并逐字节校验Setup.exe，并仅为此次进程设置TEMP/TMP。保留两者在同一文件夹；无需开发环境、修改系统TEMP、修改ACL或关闭安全软件。

生产Setup.exe为146,601,914字节，SHA256为 `7367f228517055313cf00d657fec817c7f17537ceb93440460546fabfdf163fa`。上述C盘副本与H盘原安装包字节一致；启动验证通过不等于已替用户完成正式安装。

## 故障定位与回归

用户自行双击H盘Setup.exe时出现 `Error writing temporary file. Make sure your temp folder is valid.`。真实NSIS弹窗已被本次启动进程专用探针捕获。普通Node/PowerShell写入成功，不能证明NSIS进程能写入同一目录。

本机H盘仓库EXE继承 `Mandatory Label\Low Mandatory Level`。Win32探针在H盘运行时TokenIntegrityRid为4096，GetTempFileName/CreateFile返回错误码5；同字节探针复制到C盘后RID为8192，原临时目录写入及删除时关闭文件均成功。Windows机制依据：Microsoft Learn的Mandatory Integrity Control文档，说明执行进程完整性受文件与用户完整性的最低值影响；未调整任一文件安全标签。

最终最小对比见 `output/nsis19-matrix-DHzkwj/matrix.json`：使用C盘验收驱动，H盘NSIS在默认或新C盘TEMP都失败，同字节C盘NSIS在两种TEMP都通过。生产C盘安装器真实中文启动页面见 `output/19-production-bootstrap-UySWyy`。早期 `nsis19-matrix-aYBh3r`、`nsis19-matrix-CkZu79` 对比受H盘低完整性验收驱动或同时运行向导影响，属于保留的失败记录，不能用于否定C盘启动修复。`nsis19-matrix-2bI7vC`的C盘失败是驱动取消后读取已退出窗口的竞态，修复后最终矩阵通过；它没有复现NSIS临时文件错误。

## 验收误安装记录

`output/playwright/installer19/run-TvCJtD` 中验收驱动使用GetWindowText读取另一进程的Edit控件，误判为空；在未校验目录时点击安装，写入默认 `C:\Users\flow032417\AppData\Local\Programs\Class Manager`。因此不能声称本次工作全程保留了原安装程序。该次没有启动应用；安装后的程序EXE/ASAR与18冻结身份一致。之前的完整文件身份未保存，不能声称已还原原版本或证明所有原程序文件未变。

当前默认目录198文件已逐项复制保留，见 `output/19-incident-preserved-manifest.json` 及其记录的C盘目录。没有尝试卸载或还原该目录。后续修复为：Edit使用WM_GETTEXT；安装前必须校验独立路径；每次验收安装器使用新appId与明确的独立默认目录；NSIS复制文件前也必须核对独立目录，验收版不按通用镜像名关闭用户应用。正式生产安装器仍保持正常NSIS应用检查。驱动将PID和创建时间绑定，在读取、截图与操作前重新核验身份；不能因PID复用去操作其他进程。

NSIS模板会在所选目录未包含应用名时追加 `Class Manager` 子目录。最终验收显式选择 `程序\Class Manager`，与原独立默认目录不同。早期v4/v5/v6被验收目录保护拒绝，失败工件全部保留；v7完成安装，但PowerShell默认代码页被UTF-8解码导致快捷方式路径比对误报。v8采用显式UTF-8输出，通过真实快捷方式校验。

## 完成边界

完整软件验收通过，见 `output/playwright/installer19/run-Q2qDaQ/report.json`、`output/19-installer-live-v8.log`。独立appId为 `local.classmanager.installer19.d889ba58403a`，程序目录为 `C:\Users\flow032417\AppData\Local\ClassManagerInstaller19Audit\d889ba58403a\程序\Class Manager`，合成数据在该独立根下的 `合成 数据`。

- 三个真实中文向导页面及目录修改；桌面、开始菜单快捷方式均指向独立程序目录。
- 197个已安装负载逐项匹配，包括84个18程序文件和第三方通知；默认对话首页、侧栏第一项、schema11通过。
- 同版本重装保留合成100人，重开仍进入对话；应用只使用System32 PATH也可运行。
- 实际卸载删除独立程序；65个合成业务文件完整保留，包括真正的data.sqlite、合成附件和指针，而非只核指针。
- 最终这一轮对默认程序目录198文件进行前后全量哈希及文件集合比较，通过；该前值取自误安装之后，不能用于声称误安装之前的用户程序不曾被替换。
- 模型请求0、应用页面错误0；冻结18便携ZIP保持 `a75b55deb1da268f7d067d01b2bf5020bfc1a0a665300ec8b51675dbabfe1141`。

生产包中文启动、字节身份、临时目录错误回归与完整隔离生命周期已验证。历史误安装影响尚未恢复或由接收人确认处置，所以19仍保留该未关闭项。15的接收人独立操作、干净Windows、实际模型质量、维护起算日期仍待验收；本次不沿用旧安装或一小时结论。
