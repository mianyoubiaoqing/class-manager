# 14 外设接口验收矩阵

2026-10-02。当前软件及打包检查通过，最终双轴证据复审通过，14软件接口工单关闭。

| 验收项 | 方法与证据 | 状态 |
| --- | --- | --- |
| 明确未接入，无样本/受理/送达 | 默认Adapter契约与实际教师UI | 通过 |
| ready/fault及模式隔离 | `tests/devices.test.ts`故障/发布拒绝synthetic | 通过 |
| 量纲、时段、校准和来源限制 | 同文件样本返回边界 | 通过 |
| 学生/revision/epoch/说明/确认 | 同文件8类失败及5种旧epoch | 通过 |
| 重复ID、输入冲突、受理/送达分开 | 同文件去重/查询/回执恢复 | 通过 |
| 超时/取消/迟到/竞争 | 忽略signal替身、取消前dispatch保护、终态不倒退 | 通过 |
| 通道持久查询seam | 重建Gateway恢复StoredCall，错目标/修订/模式拒绝 | 通过 |
| 实际Main信任、大小、独占槽 | `tests/main-model.test.ts`新增4项 | 通过 |
| 课堂窗口权限与115管理方法 | `scripts/devices-ui-smoke.mjs`与独立白名单桌面回归 | 通过 |
| 360px视觉、dirty、离线恢复/重开 | 实际开发及独立包 | 通过，截图已查看 |
| 全仓、构建、C盘复制/ASAR身份 | 56文件/914项，格式/类型/Lint/构建，82包文件/19dist | 通过 |
| 通用桌面各10次重开 | 开发与独立包 | 通过 |
| Standards/Spec双轴自审 | 364文件固定基线及最终差异 | 通过，两轴剩余0项 |

限制：没有真实外设接入或通知测试，客户接受情况待定。没有本单真实付费请求或真实学生数据；仅默认未接入和隔离契约替身验证。

18份证据源与归档哈希已核对，清单`output/14-evidence-manifest.json`。首轮系统TEMP拒写失败说明保留，恢复项目TEMP/TMP后全仓通过。证据：[全仓检查](evidence/14-full-check.log)、[包身份](evidence/14-package-manifest.json)、[开发外设](evidence/14-devices-development-report.json)、[打包外设](evidence/14-devices-packaged-report.json)、[开发通用回归](evidence/14-general-development-report.json)、[打包通用回归](evidence/14-general-packaged-report.json)、[360px界面](evidence/14-packaged-devices-360.png)、[最终自审](devices-audit.md)。
