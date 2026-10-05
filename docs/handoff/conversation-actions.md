# 对话执行流程修复（2026-10-03）

来源：用户反馈对话无法写入课时、座位、值日，并不能执行入分、总结确认、冻结、备份恢复、打印导出和课堂控制。沿用用户已授权的治理：读取/临时草案自动执行，正式保存及外发先确认，工具结果先脱敏。

协议为 `business-agent-v4`。新增 `createLessonDraft`、`readSeatingDraft`、`readDutyDraft`；把现有 `previewRestore`、`commitRestore` 接入对话。具名工具合计87：40只读、7临时草案、40需确认动作。Main/Preload合计133项，无任意SQL/IPC/文件路径/命令执行权限。

三个确定性复现：新建课时动作不在旧协议中；400人成座位草案分页后丢失 operationRef；100日值日草案也丢失句柄。`tests/conversation-runner.test.ts` 先红后绿验证真实 Workspace/SQLite 的准备、调整、确认写入。另一问题是8步预算不足以同时发现参数、读取版本和准备方案，现增至16步；最多两次未执行的参数纠正，未调用业务时给模型明确的 executed:false 反馈，不重试网络或不明副作用。

大型结果的字段索引保留小型根字段（含 operationRef/complete），禁止把超长文本塞回索引。草案续读走只读工具并校验工作区、令牌期限、名册和版本，不重复prepare。相同调用中的 `$new:名称` 引用绑定同一新ID，未命名 `$new` 每处独立。

新建课时复用 LessonBook 的结构、时长、引用、事务、幂等、冻结和备份校验。独立创作允许空资料选择，仍拒绝不存在的引用；额外专用模型生成仍必须选择资料。payload保留历史模型来源，新本地/对话内容显式 `authoring:local,provider:null`，不伪造模型响应。旧模型payload保持原序列化，不改变已有冻结hash。

入分先完成答卷人工复核、冻结，再准备差异、确认发布；总结先保存人工复核稿，再确认入档。参数/前置条件错误不能被描述为成功。课堂创建读取冻结课时和选定页；控制、投屏按原版本校验。打印预览可真正生成PDF并返回提交计数，submitted不等于已经出纸。Word/PPT基于同一冻结内容生成。

恢复在对话内分两次确认：先选文件并验证数量，再确认替换工作区。Main复用既有恢复流程、自动恢复副本和模块失效。App随新epoch重建对话页，并保留明确的恢复成功通知，避免恢复成功后仅出现空首页。

`scripts/conversation-actions-smoke.mjs` 使用隔离合成数据库、真实Main/Worker/SQLite、实际界面确认、真实PDF/Word/PPT/备份输出和恢复后重启回读；模型传输与系统打印回调模拟，禁止付费外发和真实打印。`scripts/verify-application-tools-release.mjs` 将此脚本作为打包版必需门禁；`scripts/finalize-application-tools-delivery.mjs` 核对冻结来源、安装向导、ZIP CRC与哈希后交付。证据路径见 `output/current-application-tools-release.json` 和候选的 `final-report.json`；失败尝试保留。

最终交付：`Agent-Actions-20261003-1801`。59个测试文件、1041项全仓测试通过；打包版23项完整操作门禁、三供应商模拟对话、通用桌面和重开验证通过。中文NSIS向导实际启动并在安装前取消，未覆盖用户现有安装。最终证据：`output/Agent-Actions-20261003-1801-kq0zDr/final-report.json`。

交付ZIP：`C:/Users/flow032417/ClassManagerDeliveries/Agent-Actions-20261003-1801-Delivery-MiQDVG/Class-Manager-0.1.0-Agent-Actions-20261003-1801-x64-Delivery.zip`，146639238字节，SHA256：`51247caa3d2b80ee581586c8e63ecca17d3d97ceb28e2fcf1ef9ed9b58bc2660`；ZIP CRC和全部交付文件哈希通过。更新前备份、保存并退出旧应用，完整解压到C盘普通目录后运行安装器；安装后新建对话，详情应显示`business-agent-v4`。
