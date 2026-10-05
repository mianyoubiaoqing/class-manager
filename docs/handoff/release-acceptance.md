# 15 Windows 初版交付验收

2026-10-02 最新：许可修复新候选已完成全仓58文件/1004项、独立包与C盘身份、全部业务UI、NSIS安装/升级/恢复/卸载验证。运行包109组件的109份通知完整，四个原问题组件已移除。新的60分钟测试持续3601393ms、353轮、11正常/1强杀重开、错误0；关闭、包装和独立进程退出均通过。原候选、审查和60分钟证据冻结，不能混用。详见[许可修复](release-license-remediation.md)。

## 许可修复新候选矩阵

| 验收项 | 实际结果 | 证据或限制 |
| --- | --- | --- |
| 全仓源码与脚本 | 58文件/1004项、格式/类型/Lint/构建通过；后续成长脚本同步等待及全格式通过 | `output/15-license-final-source-check.log`、`output/15-license-final-format.log` |
| 运行包与C盘/独立appId身份 | 83文件及19项dist-ASAR匹配，全仓重建后再次核验一致 | `output/15-license-before-stability.json` |
| 许可缺项移除 | 109运行组件、109份通知、缺项0；binary/buffers/chainsaw/https包条目和source map来源均不存在 | `output/release-audit15-license/third-party-notices/packages.json`及`unresolved.json`；Electron/Chromium另附；不改变项目UNLICENSED |
| 安装生命周期 | 普通用户安装旧07、v5→v11升级保持100人/附件、旧新备份及恢复、卸载保留数据通过 | `output/15-license-installation.log`；独立appId静默CLI，正式appId未覆盖现有安装 |
| 通用及全部业务UI | 通用10重开、备课、Office、课堂、阅卷、入分、成长、供应商、对话、设备全部通过，外部请求0 | `output/15-license-*.log`；失败/探针证据均保留；实际模型传输为替身 |
| 至少60分钟稳定性/资源/退出 | 通过，3601393ms、353轮、11正常/1强杀重开、60故障/60确认事实、错误0；60样本工作集464652–495320 KiB | output/15-license-stability-terminal.json绑定报告、启动/源、包装和独立退出证明；原报告不代替 |
| 新交付ZIP/源码/手册/样本 | 独立交付标识ticket15-20261002-license-candidate；组装器逐源/副本/ZIP往返核验 | 实际文件数/哈希以output/15-license-handoff-identity.json为准，不覆盖原候选或原1250文件归档 |
| 接收人独立演练/维护/干净Windows | 仍待用户实际结果、维护准确起止与响应方式、可用干净环境 | 开发者和自动化不代签；当前开发电脑的PATH隔离不等于干净系统 |
| Kimi/豆包真实账号及理解效果 | 未验证 | 测试费用归属已确定；本轮没有新真实付费调用授权 |

## 原候选验收矩阵（历史证据）

2026-10-02，进行中，15尚未整单通过。固定基线`output/15-release-baseline-4tsggw`400文件；16/17审查差异均冻结，15不得重建它们。

当前版本0.1.0，交付标识ticket15-20261002，Schema/备份11，管理桥接129项、课堂3项。16多供应商和17业务对话均已整单通过，客户首批Kimi/豆包预设及DeepSeek继续保留。正式写入和外发仍须分别确认。

| 验收项 | 实际结果 | 证据或限制 |
| --- | --- | --- |
| 全仓格式/类型/Lint/规则与接口测试/构建 | 通过，58文件/1004测试；后续仅补验收脚本同步，脚本格式及真实复跑通过 | `output/15-full-check.log` |
| 最终程序身份 | 通过，82个运行文件与17核验候选相同，19项dist-ASAR匹配；NSIS另含1个elevate辅助程序 | `output/15-package-manifest.json` |
| 最终NSIS与独立验收NSIS | 构建通过；正式安装器146025001字节，SHA256 `0f6fdc595877202617a67cbc89f9f71eb4c16b6f5eb602bfdf9c1a83a6cd12db` | `output/15-nsis-final.log`；正式appId安装器未覆盖原有安装 |
| 安装/替换升级/迁移/备份/卸载 | 通过，普通用户、中文路径；73个旧07文件/83个新文件一致；实际v5→v11保持100名学生身份及附件；旧备份恢复、新备份；卸载应用保留数据 | `output/15-installation-guarded.log`；独立验收appId、无快捷方式，静默CLI流程 |
| 无开发工具运行条件 | 部分通过，所有候选运行均无Node/Python/Office/localhost依赖，子PATH仅Windows System32 | 本机有开发工具，不能替代全新干净Windows验证 |
| 至少60分钟混合交互/离线/故障、资源 | 通过，3609161ms、354轮、11正常重开/1强杀重开、60次合成故障及60条确认事实、错误0；60样本合计工作集466416–498508 KiB | 原报告保持不改写；包装退出0及独立应用/子进程退出证明已绑定，见[长时审计](release-stability-audit.md)；前次短时失败保留且不计完成 |
| 最新候选各业务UI | Office导出、课堂、阅卷、正式入分、备课、成长档案已通过；17对话/供应商/外设及通用两套10重开证据按相同运行身份沿用 | `output/15-ui-*.log`；取消排查见[记录](release-cancellation-audit.md) |
| 真实文本/图像合成接口 | 历史03、11有通过记录，不冒称本轮重跑；Kimi/豆包真实账号及当前理解效果未验收 | [阅卷真实验收](grading-live-acceptance.md)、[模型操作](model-providers.md)；没有新的单次付费请求 |
| Office逐页视觉与实际编辑 | 09历史17页DOCX/18页PPTX、编辑版合计70页及WPS12.1.0.28505保存重开通过；最新同模板导出UI通过 | [Office验收](office-acceptance.md)；Word/PowerPoint未安装，未冒称实测 |
| 源码/锁文件/样本/手册/UML/许可 | 交付候选集合为`release/ticket15-20261002-candidate`及同名ZIP；逐文件与ZIP往返校验由组装器执行，实际身份见`output/15-handoff-identity.json` | 118组件、114份完整通知；binary/buffers/chainsaw/https缺完整许可通知，buffers元数据未声明许可，原始缺项不编造；[复跑前置条件](release-reproduction.md)明确历史迁移不由便携ZIP独立复跑 |
| 接收人独立演练 | 待接收人报告，开发者不代签 | [独立演练说明](user-acceptance15.md)，已准备83文件一致的C盘候选及两份CSV |
| 维护起止与账号费用 | 接收人本人、目标当前电脑、测试费用由用户承担；7天维护起算/截止/响应方式待定 | 用户2026-10-02确认；费用归属不作为自动发送授权 |
| Standards/Spec整单复审 | 待完整证据及未决项落实 | 不能因自动化通过而提前关闭15 |

环境：普通用户非管理员，Windows11专业版64位10.0.26200，i7-12700F（12核/20逻辑处理器），51365281792字节RAM。详情为`output/15-environment-utf8.json`。H盘直接启动实际失败，C盘逐项校验副本运行通过；安装入口会先复制到C盘并验证。旧安装程序当前仍保留，独立验收和合成数据不自动启用真实业务。

软件流程使用合成数据、固定传输替身；无正式教学、学生通知或真实成长档案。本阶段不是永久无需维护承诺。M1最终交付仍待本表外部/接收人条件，申报报告、演示视频及真实试点另立后续事项。
