# 前端布局优化交接与接口核查

2026-10-03。结论：当前已确认的 Windows 单机、合成数据范围具备业务后台及前端桥接，可以开始布局、视觉层级和交互呈现优化。该结论不等于全部交付验收关闭，也不把设备占位、真实模型质量或任意 Agent 工具能力说成已完成。

## 本次核查证据

- 对照需求基线、初版范围、01–18 工单、当前业务页面及 Main/Worker 实现。
- 对 TypeScript AST 做接口接线核对：DesktopApi 130 项、CHANNELS 130 项、Preload 130 项完全对应；60 项经 Main 专门处理，70 项经默认分发进入 Worker，缺失为 0。明细在 `output/20261003-ui-contract-audit.json`。该静态核对证明方法接线，不证明每个输入或工作流程正确。
- Renderer 存在 128 个接口的直接调用引用。`growthSummaryHistory`（总结草稿全部修订）、`readGradingReview`（按冻结复核 ID 读取）已实现及暴露，当前页面没有独立直接调用；现有成长页面提供事件修订、总结草稿和正式条目，阅卷页面通过草案、历史及入分流程展示复核。若设计需要独立完整草稿修订查看器或按复核 ID 定位页面，可复用这两个接口，但需要补页面与相应验证。
- 对18冻结审查清单中的14个 src/tests 文件重新核对 SHA256，全一致；未修改业务后台或页面。18当时完整检查为58文件/1014项，见 `agent-conversation-acceptance.md`，本轮未重复完整套件。
- 本轮实际重跑类型检查及5文件/182项：Main IPC、ConversationRunner、多供应商运行时、设备契约、安装启动器均通过。全部使用合成输入/受控传输；没有真实付费模型调用。
- 课堂展示窗口另有3个冻结接口：readProjection、readClock、setFullscreen，见 `src/shared/classroom-display.ts` 及 `src/main/classroom-preload.ts`。管理130项不包含这3项。

## 能力与页面对应

下列方法为代表性入口，完整输入、返回值、错误、费用及副作用以 `src/shared/contracts.ts` 和各 `src/shared/*.ts` 为准。

| 计划能力                         | 后台/前端接口                                                                                                                          | 当前页面                                                   | 边界                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| 班级、名册、成员状态             | snapshot/createClass/renameClass/saveStudent/setStudentActive                                                                          | App.tsx 名册视图                                           | 稳定ID、版本与班级归属；不重写历史                   |
| 备份、恢复、诊断                 | saveBackup/previewRestore/previewRecovery/commitRestore/exportDiagnostics                                                              | App.tsx 维护视图                                           | 先预览后确认，恢复改变工作区epoch；Schema/备份11     |
| 多供应商配置、连接检查、账本     | readModelSettings/configureModelProvider/selectModelProvider/saveModelProviderKey/prepareModelCheck/checkModelProvider/readModelLedger | ModelSettingsPage.tsx                                      | DeepSeek/Kimi/豆包独立配置；预设不证明真实账号权限   |
| 成绩导入、统计、更正、历史       | previewScores/confirmScores/readScoreVersion/scoreHistory/studentScoreHistory/exportScoreTemplate                                      | ScorePage.tsx 及子组件                                     | CSV/XLSX预览、状态和计分口径由后台决定               |
| 成绩解释草案                     | prepareExplanation/generateExplanation/editExplanation/listExplanations                                                                | ScoreExplanation.tsx                                       | 来源、草案/原稿、过期、用量和取消可见                |
| 座位布局、锁定、调整、确认、打印 | prepareSeating/adjustSeating/confirmSeating/readSeatingVersion/previewSeatingPrint                                                     | SeatingPage.tsx                                            | 随机基础编排；新版本、不可用座位及明确冲突           |
| 当期值日分组、轮换、修订、打印   | prepareDuty/adjustDuty/confirmDuty/listDutyPlans/previewDutyPrint                                                                      | DutyPage.tsx                                               | 本期快照与历史冻结；不维护永久分组                   |
| 材料导入及备课                   | previewMaterial/confirmMaterial/readMaterialImage/prepareLesson/generateLesson/editLessonDraft/freezeLessonDraft                       | LessonPage.tsx                                             | 有限格式和资料范围；人工核对、确认版本               |
| 可编辑 Word/PPT 导出             | exportLessonOffice/cancelLessonOffice/openLessonOffice                                                                                 | LessonPage.tsx                                             | 指定备课版本；原生可编辑对象，外部修改不自动回库     |
| 课堂辅助、高考倒计时             | createClassroom/controlClassroom/readClassroomClock/openClassroomDisplay/readCountdown/setCountdown                                    | ClassroomPage.tsx、CountdownBanner.tsx、classroom-main.tsx | 指定备课版本、计时/提问/进度；教师主导               |
| 图像答卷、细则、建议、复核       | createRubric/createGrading/prepareGrading/generateGrading/editGrading/freezeGrading/gradingHistory                                     | GradingPage.tsx 及子组件                                   | 普通题型、原生图像路径；看不清或复杂公式转人工       |
| 复核正式入分                     | prepareScorePublication/confirmScorePublication/readScorePublication                                                                   | ScorePublicationPanel.tsx                                  | 差异、替换确认、CAS版本及幂等事务                    |
| 成长事件、跟进、总结、入档       | saveGrowthEvent/growthTimeline/prepareGrowthSummary/generateGrowthSummary/confirmGrowthSummary                                         | GrowthPage.tsx                                             | 教师本地档案，AI草稿与正式条目分开                   |
| 音量与呼叫接口                   | readDeviceStatus/measureNoise/requestStudentCall/readStudentCall/cancelDeviceTask                                                      | DevicePage.tsx                                             | 默认未接入，没有实际采样或送达                       |
| 统一对话                         | prepareConversation/generateConversation/executeConversation/readConversation/cancelConversation/clearConversationSession              | ConversationPage.tsx                                       | 首页、导航首项、多轮、只读自动调用、Main统一工具脱敏 |

## 对话能力的确切范围

对话支持正常回答与追问，以及班级目录、名册、考试、座位、值日、备课、课堂、阅卷、成长、设备、倒计时共11类只读查询。可提出并在确认后执行的写入动作有5种：创建班级、重命名班级、启停学生、设置倒计时、保存成长事件。还可导航到现有业务页。

正式入分、确认总结、备课冻结、文件导入、恢复、打印/导出等复杂流程继续由原业务页审核操作。当前接口没有逐Token流式事件、任意文件/终端/SQL执行或持久会话历史；新增这些能力需要独立后台与协议工作，不应在布局优化时用假进度、假历史或前端直写模拟。

发送消息即确认本轮使用当前模型，可能计费；只读工具无需逐项确认。正式写入必须展示真实对象、完整内容及前后差异，再明确确认。Main负责代号映射和工具返回清洗：本地姓名显示不能再次作为原文传回模型。未知自由文字敏感信息仍不能保证全部识别，真实资料阶段另行验收。详见 `agent-conversation.md`。

当前会话只在运行内存中保留；切到业务页再返回保留，应用重开清空。App.tsx 当前让 ConversationPage 保持挂载并用 active 表示显示状态；重排布局时不能无意改变成离页即销毁组件。新对话必须同时清空 Main 会话、代号与页面消息。更换配置、恢复与旧epoch会使任务失效。

## 前端执行范围与保留规则

优先编辑 `src/renderer/` 的页面、组件及CSS，可在该目录拆分呈现组件。当前仓库存在大量已授权的未提交功能变更，开始前读取状态并保存自己的基线，避免覆盖他人变更。当前后端以 Electron Main + 数据 Worker + 本地SQLite组成，无需另建HTTP服务器。

必须保留：

1. 启动进入业务对话，侧栏第一项固定对话，已输入文本/未完成任务/未保存业务编辑的离页保护。
2. 使用 window.classManager 的现有具名方法和 Result<T>。保留 epoch、configurationRevision、expectedRevision、token、requestId、hash等后台要求，不在Renderer猜测版本或重复计算正式分数。
3. 取消、失败、完成、回包不明是不同状态。回包不明先查询原任务/原业务，不能自动重发模型调用或写入；取消请求成功不等于没有费用或撤回已提交事务。
4. 保留来源过期提示、评分逐题复核、正式入分替换差异、草稿/确认版本区别、模型外发与正式写入所需的确认。
5. 凭据仍由Main本地加密管理。不要在Renderer添加fetch直连供应商、持久化完整Key/工具原文、任意IPC透传或把本地还原后的身份内容重新发给模型。
6. 课堂显示只使用专用classroomDisplay接口及允许的投屏字段，不复用完整管理快照投屏。
7. 保留当前设备“未接入”反馈。不能用设计示例中的音量/送达/历史记录冒充后台实际状态。

可改善消息气泡、输入框、侧栏分组、工具状态卡、差异确认卡、空状态、布局间距、表格和长内容排版，以及键盘/焦点操作；减少无关实现细节。业务数据与状态需要真实接口响应支撑。

## 验证与交付

执行 RTK.md 约束，所有shell命令以rtk开头。完成改动后运行 `rtk npm run check`，根据影响范围复跑 `scripts/conversation-ui-smoke.mjs`、`scripts/providers-ui-smoke.mjs` 及对应业务UI脚本。独立打包后再做相同页面回归，保留新截图、报告和包身份；旧截图不代表新布局通过。

至少核验桌面与360px窄窗口、最长文本/长列表、空数据/缺模型配置、键盘发送与换行、侧栏导航、多轮只读工具、写入取消与确认、回包不明查询、新对话、供应商切换和应用重开。界面不得横向溢出、遮挡确认内容或把“理解中”冒充逐Token输出。

本机H盘原生EXE存在已记录的低完整性启动限制；按已有复现说明在C盘独立候选和合成数据目录验证。不要自动安装覆盖或卸载用户默认程序，不调用真实供应商，不导入真实学生资料；原包、ZIP、diff、失败报告和证据保留。

尚未关闭：真实Kimi/豆包账号和模型效果、干净Windows与接收人独立操作、7天维护起算；真实硬件接入属于后续范围。工单19历史验收误安装事件仍须独立核对处置；本次目录修正不关闭该事件，15外部交接不关闭。

可给前端模型的任务：请先读本文及contracts.ts，以现有业务功能和审核状态为基础优化src/renderer的UI布局，保持对话首页和侧栏置顶；完成类型、全仓检查和受影响页面的合成桌面验证，交付截图、改动说明及未解决问题。若设计需要当前协议没有的能力，先明确接口需求，勿伪造结果。

# 最新接口补充

当前管理接口为 148 项，新增点名与学生资料 8 项；对话业务工具为 95 项。新增页面与契约见 [当前更新](context-pupils-update.md)，下面保留原冻结布局核查。
