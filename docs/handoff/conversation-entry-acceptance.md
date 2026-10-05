# 17 对话入口验收

2026-10-02，最终软件验证通过；双轴整单证据复审均通过，17关闭。仅使用合成数据和确定性传输替身。

| 项目 | 已执行结果 | 证据 |
| --- | --- | --- |
| 最小确切外发/三供应商/隔离/单次消费 | 通过，发送字节与预览一致，不自动带学生身份或历史结果 | `output/17-review-fix-tests.log` |
| 原业务查询/有限写入/两次确认/幂等/CAS/未知回执 | 通过，提交后丢回包不可再次写入，取消仍unknown | 同上 |
| 实际Main权限/大小/模型互斥/配置切换/写入独占 | 通过；修正定向3文件129测试 | 同上 |
| 修正后全仓格式/类型/Lint/测试/构建 | 58文件/1004测试通过；后续只修正两个验收脚本的白名单/报告文字，格式检查和实际复跑通过 | [最终检查](evidence/17-final-full-check.log) |
| 首轮实际开发界面 | 通过，三供应商、两个确认、错误取消、课堂权限、恢复和离线；外部请求0 | `output/17-conversation-development.log` |
| 修正后开发/独立包对话UI | 均通过，外部请求0、errors空；桌面/360px实际查看，差异及确认无遮挡 | [开发](evidence/17-conversation-development-report.json)、[独立包](evidence/17-conversation-packaged-report.json) |
| 通用两套各10重开 | 均通过，包含原业务、权限、备份恢复、错误/离线；失败白名单日志保留 | [开发](evidence/17-general-development-report.json)、[独立包](evidence/17-general-packaged-report.json)、[早期失败](evidence/17-general-development.log) |
| 独立包供应商/默认外设回归 | 均通过，实际Main/Worker/SQLite；供应商替身外发0，默认外设无值/未送达 | [供应商](evidence/17-providers-packaged-report.json)、[外设](evidence/17-devices-packaged-report.json) |
| 最终Standards/Spec整单证据复审 | 通过，两独立代理亲自核验日志/归档/包身份及四张最终截图，Standards硬违规/需整改smell和Spec缺失/错误/越界均0 | [自审记录](conversation-entry-audit.md) |
| 真实账号权限/自然语言理解质量 | 未执行 | 不用合成替身声明实际效果 |

早期失败时钟测试和首轮视觉问题如实见自审。阶段截图不能替代修正后最终候选身份。正式操作结果按原业务保存，对话正文/令牌不入业务备份和诊断。

最终源包为`output/release-audit17/win-unpacked`，测试副本为`C:/Users/flow032417/AppData/Local/class-manager-conversation-audit17-bG6zJA`，EXE SHA256为`241d83537ab6ec7abb6aa3ec34b87de94a86b6bbfd3be167e43c5f66d27627f4`，ASAR为`6d8ef039b7867d1a68f5c8d0e96c55f26de8f646b256c95b1c3c5c1e95a498d5`。[完整包身份](evidence/17-package-manifest.json)记录82个复制文件和19个当前dist/ASAR内容匹配；运行报告exe路径即此副本。归档20份/488276字节，`output/17-evidence-manifest.json`逐项记录原始/归档路径、字节及哈希，并已双向核验。最终安装生命周期和60分钟混合验证仍属15。
