# 会话管理与教师界面

2026-10-04：增加侧栏会话管理并隐藏技术详情入口。协议为 `business-agent-v8`，Schema/业务备份仍为11。本说明取代旧文档中“新对话清空记录、聊天重启丢失、展开参数JSON”的描述。

## 教师操作

启动进入业务对话；侧栏第二项“会话管理”可查找、继续、新建、重命名和删除聊天。记录按更新时间排列，搜索标题和最近消息。第一次发送内容成为默认标题。新会话保留旧聊天，删除需要确认，不删除已完成的课时、分数、座位等业务结果。

聊天、教学卡片、草稿和班级/学生选择加密保存在当前Windows用户的本机应用目录，重启可继续。后台保存不阻断导航，切换/重命名/删除/正常退出等待最新保存。失败保留最新待存内容供“重试保存”；损坏文件保留并报错，不静默清空。

对话不再提供脱敏上下文、工具JSON、原始参数及技术来源展开入口。正式操作展示中文名称、真实对象及“目前 / 确认后”的业务内容；长列表每组20项可翻页。回执使用教师语言，错误不显示内部错误码或操作编号。模型正文也要求使用通俗中文。

正式写入仍需本次确认。历史不恢复执行令牌、待确认操作或推理内容。重启历史只作脱敏交流背景，模型需重新读取事实并准备新提议。恢复工作区后开启新会话，旧聊天保留供只读查看。

## 实现与边界

- `ConversationHistoryStore` 通过已有 `CryptoProvider` / `safeStorage` 保存 `userData/conversation-history/<uuid>.chat`；原子写入及revision/CAS防止旧保存覆盖和删除后复活。
- 六个历史IPC由Main验证epoch和可信主窗口。退出握手仅允许最后的聊天保存，不能开始业务操作。
- 严格schema只存可见聊天、文稿/课时预览、草稿和选择，不存工具消息、参数、reasoning或token。聊天不进入业务备份、诊断或交付包。
- 最多100段，每段最近60条可见消息，明文2MiB、密文4MiB。Runner恢复最近48条脱敏历史（最多640KiB）；最多10个内存会话，空闲会话可驱逐后从档案重载。
- 历史标记 `historical-chat-not-authorization`。200条消息/1MiB、16次往返、每批8工具及逐项确认/确认后自动继续保留。
- 浏览器开发预览仅模拟内存会话，不提供真实桌面执行或重启持久化。
- 模型测试使用确定性模拟，未进行新付费调用。断电或强杀可能丢失尚未保存的最后编辑；正常关闭已验证最后保存。

## 验证

新增测试覆盖CRUD、加密、重开、CAS、删除防复活、旧epoch、拒绝执行字段、损坏文件、容量，以及历史脱敏/重新确认、超过10个空闲会话和教师预览分页。

开发桌面：`output/playwright/conversation-sessions/run-EPkPRe/sessions-smoke-report.json` 六项通过，含原生关闭保存、safeStorage密文、重启续聊、保存失败重试及旧确认不复活；360像素与完整界面截图同目录。三供应商/丢回包/取消：`output/playwright/conversation18/run-eFVw2w`。最终包以新 `Agent-Sessions-*` 发布目录及 `final-report.json` 为准，旧 `Agent-Context-*` 不含本功能。

最终交付 `Agent-Sessions-20261004-1036` 已完成。62文件/1084项全仓检查、最终包六项会话检查、31项业务操作、三供应商模拟对话、通用桌面与重启均通过；NSIS中文向导启动后取消，未覆盖用户安装。ZIP CRC、交付文件SHA256、ASAR/源文件及109份运行依赖许可核对通过。

最终报告：`output/Agent-Sessions-20261004-1036-AyftJq/final-report.json`。

交付包：`C:/Users/flow032417/ClassManagerDeliveries/Agent-Sessions-20261004-1036-Delivery-bLYcfI/Class-Manager-0.1.0-Agent-Sessions-20261004-1036-x64-Delivery.zip`。

ZIP SHA256：`9fd07e9f549554a9c665bbd64cd3c959d3bd3ee1e0069c92fa13c087d6308844`。最终会话截图：`output/playwright/conversation-sessions/run-qN8OMy`。模型传输和系统打印提交使用模拟，实际PDF/Office/备份输出已生成并核对。
