# 多供应商模型实现与官方依据

2026-10-02。对应工单16；实际范围为DeepSeek、Kimi、豆包的固定端点、独立配置/凭据/账本及四项现有业务接入。没有真实账号权限或付费结果验收。统一对话入口属于后续17。

## 官方依据与取舍

- Kimi[当前模型列表](https://platform.kimi.com/docs/models)实际下载到`output/16-kimi-models.html`。列表包含K2.6、K2.7 Code和K3；K2.5已于2026-08-31下线，不再作为默认预设。
- [K2.6官方指南](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)下载到`output/16-kimi-k2-6-quickstart.html`。原生文本/视觉、`https://api.moonshot.cn/v1`、Bearer和`thinking: {type: disabled}`均有明确示例。本实现默认文本和图像均`kimi-k2.6`，不传采样参数。
- [K3官方指南](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)下载到`output/16-kimi-k3-quickstart.html`。K3始终思考，支持顶层`reasoning_effort: low`；输出预算使用`max_completion_tokens`。本实现显式选择K3时检查预算1024，不发送旧`max_tokens`或禁用思考参数。1024是本应用检查预算，不是官方最低值声明。没有使用原生工具调用或多轮assistant消息，业务为单次有界草稿请求。
- 豆包依据火山方舟[官方SDK固定提交](https://github.com/volcengine/volcengine-python-sdk/tree/629d09880eff23a283a2af1dd98b65294776e614)，`_constants.py`、`_client.py`、`completion_create_params.py`和`thinking.py`原文在`output/16-official-sdk-details.json`。确认方舟地址`https://ark.cn-beijing.volces.com/api/v3`、Bearer、图文messages、json_object和disabled thinking字段。没有凭空编造用户账号可用Model/Endpoint ID；须在本地填写。

K2.7 Code的持续思考消息、联网搜索、视频、供应商文件存储及第三方任意地址未纳入本单。预设协议和当前型号不表示特定账号权限已验证；实际开通、余额和图像权限由本地一次确认调用验证。无真实调用时能力保持“未验证”。官方变化后更新本模块及证据，不能以“兼容OpenAI”代替核对。

## 模块边界与生命周期

`ModelRuntime`拥有持久UUID配置版本、供应商选择、固定协议、独立安全凭据、用量及检查生命周期。配置在userData根`model-providers.json`；Key由Electron safeStorage加密到`credentials/{provider}.enc`，用量为`{provider}-ledger.json`，均在业务备份外。保留原DeepSeek文件名及旧账本。

Main先取消四个runner、检查及Worker内未消费准备，再保存配置/Key。检查必须确认确切token/revision/body哈希，一次消费；发送前落账，取消/超时/回包不明不自动重发或切换供应商。账本完成按原调用ID及供应商，重复完成不会再次累加Token，未知usage不写成0。HTTP错误、坏JSON、过大返回及迟到响应失败；不会将完整Key从供应商回显到IPC/账本。

成绩解释、成长总结、备课、阅卷捕获确切provider/model/configurationRevision，持久原稿还记录promptVersion、response ID/model和usage。文本/图像型号各自选择，未配图像时拒绝外发。业务输出仍由原模块验证和人工审核，不自动入分、入档或冻结。

业务Schema/备份升为11，支持旧10事务迁移并保留迁移前副本；没有新增业务表。提升版本防止旧程序误开含Kimi/豆包新来源的记录。课堂Preload保持3个只读展示操作，管理桥接新增9个具名方法，共124个；来源和payload限制由Main检查。

## 操作入口

“模型设置”进入多供应商页。编辑供应商→保存文本/图像型号→本地输入并加密保存Key→“使用此供应商”。编辑供应商和当前业务供应商分别显示；只编辑不会自动切换或请求。图像型号留空禁用图像请求。Key不通过聊天交接。

连接检查先显示固定Ping或合成1×1图像的实际JSON和接收端点，再勾选本次可能付费确认，单次发送。取消后先核对原调用用量，未知账单需在供应商控制台确认。读取用量不联网。删除Key保留历史及账本。原DeepSeek设置作为兼容入口保留。
