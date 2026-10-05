# 18 对话首页与工具脱敏验收

2026-10-02：软件检查、独立包验证及最终 Standards/Spec 整单证据复审均通过，18软件完成。仅使用合成数据和传输替身；真实账号的理解质量、权限与费用未实测，15外部交接仍未完成。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 最终格式/类型/Lint/全仓测试/构建 | 58文件、1014项通过；随后仅修复通用/供应商验收脚本定位，格式及实际复跑通过 | [最终检查](evidence/18/output/18-final-source-check.log) |
| 已知短学号/单字姓名/协议完整性 | 实际 Runner 外发与两轮历史断言通过；保留协议数字、布尔、键和枚举 | `tests/conversation-runner.test.ts` |
| 工具脱敏/成长边界/正式写入/取消/配置/未知回执 | 专项与Main测试、真实桌面通过；完整成长私有正文及未确认草稿不回传 | 同上及下列桌面报告 |
| 开发及独立包对话 | 默认对话首页、侧栏首项、三供应商直发、自动工具反馈、多轮记忆、离页返回、新对话、360px写入确认、错误取消均通过 | [开发](evidence/18/conversation-development/report.json)、[独立包](evidence/18/conversation-packaged/report.json) |
| 已完成生成后丢回包 | 自动回读及首次回读失败后手动回读均恢复已有答复；答复一次，模型调用不增加 | 同上 |
| 通用两套各10重开 | 原业务、权限、备份/恢复、错误、离线与数据保留通过 | [开发](evidence/18/general-development/report.json)、[独立包](evidence/18/general-packaged/report.json) |
| 独立包供应商与默认外设 | 加密配置/账本/恢复/删除隔离通过；未接入外设无值/未送达 | [供应商](evidence/18/providers/report.json)、[外设](evidence/18/devices/report.json) |
| 新包身份及许可通知 | 84负载文件、19项dist/ASAR与C盘副本一致；109依赖及109份通知，无缺项 | [包身份](evidence/18/output/18-reviewed-package-manifest.json) |
| 最终双轴整单复审 | Standards硬违规/需整改smell均0，Spec缺失/错误/越界均0 | [复审](agent-conversation-audit.md) |

最终开发首页与窄屏写入确认、独立包首页与窄屏长对话截图已实际查看，无遮挡和横向溢出。全部新对话、供应商、外设报告外部请求0、errors空，成功报告在应用关闭后写出。

失败记录保持原状：首次检查工具误用了不存在的npm路径；首次打包CLI参数被解释为配置路径；早期桌面脚本等待和历史判断失败；欢迎语遮挡已修；审查修复后的通用脚本漏`clearConversationSession`白名单，供应商重开后“模型设置”按钮定位重复，均修复并真实复跑。许可汇总工具首次未转换Windows ASAR路径，未修改包，修正后完成新通知目录。所有原失败日志与阶段成功日志均保留，不将阶段结果当最终包结果。

证据归档52份、1951933字节；`output/18-evidence-manifest.json`逐项记录原件与归档的SHA256。其中变更文件清单是加入最终验收文档前的阶段快照，原字节已保存为`output/18-review-files-stage-before-docs.json`；当前变更清单和差异另行复审冻结。413文件基线、15原ZIP、16/17冻结差异重新核验未变。18新包不继承15原一小时稳定性或安装生命周期证明。

源码及业务Schema/备份仍11，Main/Preload管理操作130项。新包为`output/release-audit18-reviewed/win-unpacked`，C盘已验证副本为`C:/Users/flow032417/AppData/Local/class-manager-agent18-VsVNMF`。双击副本中的`启动业务对话.cmd`使用独立`agent18-test-data`目录；首次在模型设置填入自己的Key/型号。便携交付集合为`release/ticket18-20261002-agent-conversation`，ZIP及SHA256以`output/18-delivery-identity.json`生成结果为准。无新NSIS或一小时验收声明。
