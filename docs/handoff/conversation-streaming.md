# 流式对话与教学内容交互（2026-10-03）

后续同轮多工具调用故障已在 v6 修复，见[批量调用修复](conversation-batch.md)。本文保留 v5 实现及旧交付证据。

用户反馈：制定教学计划时出现 `INVALID_RESPONSE`，要求放宽回复格式、支持流式传输与思考后的工具调用，并在对话中展示教学计划、课件和直接确认按钮。沿用读取/临时草案自动执行、正式写入及外发前确认、工具结果先脱敏的授权。

## 原因与复现

旧 agent 的客户端接受普通文本响应，但 Runner 把整个正文再次强制解析为 `conversationOutput` JSON。普通教学计划和带 Markdown 围栏的有效动作均在 `agentRequest` 抛出截图中的错误。两个确定性测试在修改前失败，修改后通过：`rtk npx --no-install vitest run tests/conversation-runner.test.ts -t 'agent accepts'`。未读取用户真实模型原包，不能断定截图中的原包究竟是哪一种。

## 实现

新协议 `business-agent-v5`：自然正文/Markdown直接显示；兼容旧JSON封装和代码围栏。具名业务动作由原生 `business_action` 工具传递并继续使用原Zod、CAS、事务和确认哈希。`present_document` 只展示教学方案，不写入业务。87项业务工具未扩大到任意路径、命令、SQL或IPC。

对话专用传输与原有阅卷/备课专用JSON生成分开，DeepSeek、Kimi和豆包使用 SSE、原生 `tool_calls`、`role:tool` 回执。SSE解析支持分片UTF-8、CRLF、分段工具参数、finish/usage/DONE；未完整结束、取消、超限或截断的工具参数不可执行。每次调用独立记账，无网络失败自动重试或跨账号回退。继续采用每轮16次往返；对话输出16384 token，单请求3分钟，响应上限2MiB，请求正文1MiB，会话历史640KiB/10轮，按完整轮清理。

启用供应商思考能力并在后续工具调用中携带必要 `reasoning_content`；推理文字经过脱敏后仅用于当前会话，不写入业务库或账本正文。主界面显示思考状态、流式正文和已执行工具，不单独渲染思考文本；高级上下文详情可包含经过脱敏的历史思考字段。界面通过现有只读 `readConversation` 获取增量状态，没有新增跨进程订阅权限。正式操作仍停在proposed；确认后回执、取消和失败均补齐工具配对，不留下悬空工具消息。

教学计划以对话卡片呈现，可收起/展开、点击“确认计划并继续”。此按钮只发送卡片所展示的下一步请求，未提前授权尚未显示的正式业务动作。待保存课时的预览来自实际已绑定的 `createLessonDraft` / `editLessonDraft` 内容，可查看教学目标/重点/难点/环节，切换课件视图、上下翻页和查看答案。正式确认按钮直接提交当前对象、内容及actionHash，不再强制复选或输入“确认”。恢复仍分别确认预览和覆盖。文稿和课件用React文本渲染，不执行模型HTML/脚本或加载远程图片。原始图片仍在备课页面查看。

## 验证与证据

相关157项测试通过，包括纯正文、围栏、原生工具配对/脱敏、思考上下文续传、正式写入确认及幂等、文稿卡片、SSE未结束/取消/截断。开发桌面25项完整门禁通过，含回复结束前可见正文、按钮继续生成教案课件、翻页、360px布局、真实保存/入分/导出/备份恢复及重启回读。开发证据：`output/agent-actions-6pootj/actions-smoke-report.json` 和 `stream-plan-courseware-360.png`。

实际模型传输和打印回调使用模拟；PDF、Office、备份与SQLite写入/恢复均实际执行。本次不证明真实账号的思考/工具权限及所有自然语言规划结果。最终打包证据及ZIP以 `output/current-application-tools-release.json` 和其 `final-report.json` 为准。

最终交付 `Agent-Stream-20261003-2101` 已通过：60个测试文件/1054项全仓检查、三供应商模拟对话、通用桌面和打包版25项完整操作、NSIS中文向导启动（安装前取消）、ASAR/109项运行依赖许可、ZIP CRC与全部文件哈希。证据根目录：`output/Agent-Stream-20261003-2101-yt2YNc`。

ZIP：`C:/Users/flow032417/ClassManagerDeliveries/Agent-Stream-20261003-2101-Delivery-Sqj6JY/Class-Manager-0.1.0-Agent-Stream-20261003-2101-x64-Delivery.zip`，146653345字节，SHA256：`9572f69111361fab3ff90a9de5e4c71271f9739b83b65127e59a6e5d5fae6d66`。更新前备份并退出旧应用，完整解压到C盘普通目录后运行安装器；更新后新建对话使用v5。未覆盖用户现有安装。

## 协议参考

核对一手文档日期：2026-10-03。

- DeepSeek Thinking Mode / Tool Calls：`https://api-docs.deepseek.com/guides/thinking_mode`、`https://api-docs.deepseek.com/guides/tool_calls`
- Kimi 思考模型 / Tool Calling：`https://platform.moonshot.cn/docs/guide/use-kimi-k2-thinking-model`、`https://platform.moonshot.cn/docs/guide/use-kimi-k2-tool-calls`
- 火山方舟 Chat Completions 参数：`https://www.volcengine.com/docs/82379/1494384`

这次故障来自把用户可见正文与可执行业务参数绑在同一强格式封装中。现在正文、传输和业务校验分开，并以真实多步工具与UI验证约束其边界。
