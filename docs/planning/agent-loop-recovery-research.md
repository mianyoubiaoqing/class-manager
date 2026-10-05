# Agent 工具失败与循环恢复调研

调研日期：2026-10-04。范围：工具参数错误、执行失败、工具消息配对、恢复预算与有副作用操作防重放。依据一手官方文档及源码；这是本次修复的设计参考，不表示本项目已经实现或通过验收。

## 结论与当前现象

截图中的“工具参数不是完整JSON，尚未执行”对应本地解析阶段停止。仅凭截图不能确定是输出截断、供应商不完整参数、流式拼接异常，还是错误边界直接终止任务；应由合成模型回包驱动现有 Runner 复现，再依据原始事件顺序定位。

建议采用“错误也是一次工具结果”的恢复方式：尚未执行的参数错误回送模型修正；确定可重试的工具执行异常按有限策略处理；成功或结果不明的正式写入先核对原回执。不要把所有异常都归为整个任务失败，也不要取消现有正式写入确认。

## 一手来源中的成熟模式

| 主题 | 官方行为 | 来源 |
| --- | --- | --- |
| 参数验证与模型修正 | Pydantic AI 在工具参数验证失败时给模型返回验证错误，允许模型重新调用；工具可以主动抛出 `ModelRetry` 请求修正，次数受工具重试配置约束。 | [Pydantic AI advanced tools](https://ai.pydantic.dev/tools-advanced/) |
| 失败属于工具回执 | Pydantic AI 的 `RetryPromptPart` 可携带失败的工具名称和 `tool_call_id`；模型定向获得该调用的修正提示。 | [Pydantic AI messages API](https://ai.pydantic.dev/api/messages/) |
| 流式参数不保证完整 | Anthropic 的细粒度工具流可能在最终累计后仍含非法或不完整 JSON。官方示例捕获解析失败，回送标为错误的工具结果；输出遇到 `max_tokens` 时也可能中断参数。 | [Anthropic fine-grained tool streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming) |
| 输出截断需要单独识别 | Anthropic 按 `stop_reason` 区分正常结束、工具调用与 token 截断。官方工具文档示例对被截断的工具块重新生成，并指出 `pause_turn` 可继续同一流程。该策略是其协议行为，不能假定本项目三家供应商字段一致。 | [Anthropic implementing tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use) |
| 配对和错误标记 | Anthropic 规定工具结果使用对应 `tool_use_id`，工具错误可设 `is_error: true`；工具结果需紧随发起调用的 assistant 消息，且应排在用户消息中的普通文本之前。 | [Anthropic implementing tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use) |
| 可预期错误回送模型 | LangChain 的工具包装中间件可捕获工具异常，返回携带当前 `tool_call_id` 的 `ToolMessage`，使 agent 在得知失败后继续推理。 | [LangChain agents: tool error handling](https://docs.langchain.com/oss/python/langchain/agents) |
| 执行重试与恢复分开 | LangChain `ToolRetryMiddleware` 支持按异常或谓词筛选重试、工具范围、退避和抖动；达到上限后可以继续并给模型错误结果、重新抛错或自定义处理。它默认可捕获广泛异常，所以本项目应显式缩小到已判定安全的工具/错误。 | [LangChain built-in middleware: tool retry](https://docs.langchain.com/oss/python/langchain/middleware/built-in) |
| 请求、执行次数均有预算 | Pydantic AI `UsageLimits` 分别限制模型请求和成功工具调用；请求限制在请求前检查，工具限制在整个待执行批次前检查，超出时不执行该批次。 | [Pydantic AI usage API](https://ai.pydantic.dev/api/usage/) |
| 恢复需要可重放纪律 | LangGraph 在恢复时可能重放入口到中断点的代码。官方要求外部副作用封装为持久任务，避免同一任务包含多项副作用，并为写操作使用幂等键或先检查已有结果。 | [LangGraph functional API](https://docs.langchain.com/oss/python/langgraph/functional-api)、[对应官方源码](https://raw.githubusercontent.com/langchain-ai/docs/main/src/oss/langgraph/functional-api.mdx) |
| 可预判循环上限 | LangGraph 支持 `recursion_limit`，达到时产生 `GraphRecursionError`；官方图 API 示例通过 `RemainingSteps` 在触顶前转入收束分支。 | [LangGraph graph API 官方源码](https://raw.githubusercontent.com/langchain-ai/docs/main/src/oss/langgraph/graph-api.mdx) |

## 适配本项目的建议（设计推论）

下述是根据前述来源与本项目已有确认、脱敏、回执机制提出的实现建议，不是官方 SDK 的现成保证。无需为了此修复迁入某个 agent 框架。

### 1. 将解析结果与执行结果纳入同一循环

对每个工具调用产生内部结果：成功、可修正、不可执行、结果待核对。非法 JSON、schema 不符、未知工具、无效对象代号都属于“尚未执行”；给出简短错误类别和可操作修正提示，允许模型继续。不要猜测补全 JSON 后直接执行。

失败回执只包含脱敏的错误信息、允许的字段提示与下一步建议。不能把原始参数、内部路径、账号、学生信息或调试栈直接回送模型；供应商文档中回送原始非法 JSON 的示例不能照搬。

流式拼接先以调用序号/ID聚合参数，待结束信号后统一解析；同时核对 stop reason、调用标识唯一性、数量、名称、累积字节与传输中断。区分模型内容不合规、传输协议损坏和网络异常，后两者不能伪造一份完整 assistant 工具消息。

同一原生批次中的每个调用必须有一份对应回执。遇到正式操作待确认时保存剩余队列；不得在这些回执尚未闭合时再次请求模型。拒绝或取消也要形成对应的明确未执行结果，以免供应商拒绝后续上下文。

### 2. 分开“执行器重试”与“模型修正”

| 类型 | 建议策略 |
| --- | --- |
| 参数、对象代号或业务校验错误，已知未执行 | 由模型修改参数或重新查询依据；不原样反复提交。 |
| 只读/草稿的暂时性失败 | 仅对白名单错误做短暂、有限退避；仍失败则把结果送模型选替代路径。 |
| 正式操作准备失败，已知未执行 | 允许重新读取并生成新的实际提议；仍经过用户确认。 |
| 正式执行成功 | 保留回执并继续，不重复提交已完成操作。 |
| 正式执行已开始但回包不明 | 查询原任务/业务结果；不得通过异常捕获重新调用写入。 |
| CAS 版本变化 | 提示刷新依据并准备新提议，旧确认失效。 |
| 取消、会话/工作区失效、配置变化、禁止能力 | 终止相应任务，不以自动重试绕过边界。 |

重试不得把“一次确认”扩展为任意后续写入授权；模型修改正式内容后要重新展示实际内容。对外导出、打印、课堂控制与恢复等同样不能因为没有数据库写入就被当成只读操作。

### 3. 用预算与进度检测避免循环再次被破坏

沿用现有总模型轮数上限，另设每调用修正次数、连续无进展次数、可重试工具执行次数与错误反馈字节上限。每次请求和执行前检查；重试也计入总预算。保留取消响应，退避等待应可取消。

对成功的重复读请求优先复用既有脱敏回执，提醒模型它已经获得该资料；对失败的重复调用允许有限修正机会。以工具、标准化参数、对象版本、结果状态形成指纹，避免将读取更新后的业务状态误判为死循环。

每次成功执行或有新的查询结果算作进展；相同错误重复且参数未变化属于无进展。临近预算时给模型一次收束提示，向老师说明已完成内容、仍未完成的步骤及下一步。展示“正在修正/重试”“需要确认”“需核对执行结果”等自然语言，不恢复原始参数或思维链入口。

### 4. 必须覆盖的回归矩阵

- 非法 JSON/截断、schema错误、未知工具与无效代号：错误回执进入模型后修正成功，不执行原错误调用。
- 部分合法的多调用批次、正式确认夹在批次中、取消/拒绝：每个 tool call 配对完整，无重复执行，无未闭合消息进入下一模型请求。
- 临时只读失败、不可重试错误、重复失败、反复成功读、长内容：有限恢复并在预算内收束。
- 已成功写入后错误、写入回包不明、版本变化、配置变化、工作区恢复：不重放成功或不明操作，旧确认不会套用到新内容。
- 流式参数分片、跨调用交错、供应商结束原因、传输中断：区分协议完整性和业务可修正失败，UI不会长期停留在生成中。
- 真实课堂流程的合成测试：先读已有课件与课堂状态，故意给出坏工具参数，修正后进入确认，确认后执行并自动继续。

## 调研限制

文档已按2026-10-04可访问官方来源核对；各 SDK 文档属于持续更新内容，实际采用前应以本项目锁定版本为准。本项目未运行外部框架、未发起付费模型请求；三家实际供应商的流式事件、字段与结束原因必须由本项目现有 mock/协议回归验证。外部 SDK 的恢复示例不能替代本地 Main/Worker/CAS 和确认语义。
