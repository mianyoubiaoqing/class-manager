# 初版工单草案

日期：2026-09-29。用户已授权 M0（01、02）实施，实际检查与剩余验收见 `../handoff/m0-verification.md`。03 至 15 仍为后续草案，没有向外部 tracker 发布，不因 M0 授权自动开工。

拆分采用端到端行为：每张功能工单包含所需界面、应用操作、持久化、测试与手册更新，不按“先写全部数据库，再写全部页面”划分。基础依赖先于调用方；表中只列直接阻塞项。

## 建议拆分

1. [01 Windows 安装与合成名册](../../.scratch/initial-release/issues/01-desktop-roster.md)。Blocked by：无。交付安装启动、建立合成班级与学生、关闭重开的最小路径。
2. [02 备份恢复与诊断](../../.scratch/initial-release/issues/02-backup-restore.md)。Blocked by：01。交付可验证备份、安全恢复、故障后保留旧数据。
3. [03 DeepSeek 本地配置与连接检查](../../.scratch/initial-release/issues/03-model-settings.md)。Blocked by：01。交付安全设置及分别验证文本/图像的合成请求。
4. [04 成绩导入与确定性统计](../../.scratch/initial-release/issues/04-score-import.md)。Blocked by：01。交付表格预览、确认、保存与可复核统计。
5. [05 成绩解释草案](../../.scratch/initial-release/issues/05-score-explanation.md)。Blocked by：03、04。交付基于已算指标的 AI 解读与来源过期提示。
6. [06 座位编排与打印](../../.scratch/initial-release/issues/06-seating.md)。Blocked by：01。交付布局、锁定、随机填充、调整与确认打印。
7. [07 当期值日分组轮换](../../.scratch/initial-release/issues/07-duty.md)。Blocked by：01。交付当期组、轮换、岗位到人、临时替换、打印和历史保护。
8. [08 资料驱动的备课版本](../../.scratch/initial-release/issues/08-lesson-drafting.md)。Blocked by：03。交付材料选择、结构化教案课件草稿、编辑与版本保存。
9. [09 可编辑 Word 与 PPTX 导出](../../.scratch/initial-release/issues/09-office-export.md)。Blocked by：08。交付同版教学内容的可编辑文件及失败保护。
10. [10 课堂辅助与倒计时](../../.scratch/initial-release/issues/10-classroom-countdown.md)。Blocked by：08。交付离线展示、计时进度与可配置目标日期。
11. [11 图像答卷建议与复核](../../.scratch/initial-release/issues/11-grading-review.md)。Blocked by：03、04。交付考试学生绑定、细则、图像建议与人工核对，不在此工单直接入分。
12. [12 复核结果正式入分](../../.scratch/initial-release/issues/12-grading-publication.md)。Blocked by：11。交付经确认的分数进入成绩分析，幂等且可追溯。
13. [13 成长记录与阶段总结](../../.scratch/initial-release/issues/13-growth-profile.md)。Blocked by：03、04。交付事实记录、成绩引用、AI 草稿与确认入档。
14. [14 外设未接入契约](../../.scratch/initial-release/issues/14-device-contracts.md)。Blocked by：01。交付两个硬件接口、状态和可验证失败行为，不模拟完成真实动作。
15. [15 全功能稳定性与交接验收](../../.scratch/initial-release/issues/15-release-handoff.md)。Blocked by：02、05、06、07、09、10、12、13、14。交付完整检查、安装候选、源码和手册，不以模拟替代真实接口检查。

## 里程碑与工作顺序

- **M0：01 + 02。** 优先证明能安装、保存、重开和恢复，随后才扩展功能；不把 M0 宣称为完整初版。
- **M1：03 至 15。** 八项软件能力与设备接口均按合成数据验收，模型路径包含小样本真实接口检查。
- 功能优先顺序保持成绩工作流程先行；08 与 11 可在依赖满足后分别推进，材料解析共用受限接口但不要求先建通用知识库。
- 15 是集成检查和用户接手的端到端交付，不是把所有工单缺失的测试和手册集中留到最后。
- 依赖只是代码和验收的必要前提，不代表必须并行开发。单人场景按稳定底座、成绩、教学、阅卷、其余模块逐项闭环；任何阶段都不访问真实学生数据。

2026-10-01 前交付是目标而非工作量证明。当前已有 M0，但未完成目标机器实测及八项软件业务，不能给出可信的逐小时工期保证。若截止时仅 M0 达标，应准确交付 M0 并列出未完成项，请客户决定后续日期，不把按钮占位或 mock 结果算作功能完成。

## 需求追踪

| 需求 | 工单 |
| --- | --- |
| REQ-01、12、13：高中单机桌面与平台隔离 | 01、02、15 |
| REQ-02：成绩优先与软件功能齐备 | 04 至 13、15 |
| REQ-03：正式动作教师确认 | 04 至 13，尤其 12、13 |
| REQ-04、06、19：暂不进入真实业务 | 全部 |
| REQ-05：DeepSeek | 03、05、08、11、13 |
| REQ-07、08：可维护、UML、规范、交接 | 全部，15 总验收 |
| REQ-09：设备接口例外 | 14、15，客户接受状态仍待确认 |
| REQ-10：图像普通题型阅卷 | 11、12 |
| REQ-11：教师主导课堂辅助 | 10 |
| REQ-14、15：上传资料与可编辑导出 | 08、09 |
| REQ-16、17、18：座位、值日、成长 | 06、07、13 |
| 原始功能清单：高考倒计时 | 10 |
| CON-01 至 06：期限、预算、单机与维护窗口 | 03、15及本索引的阶段边界 |
| DEL-01、03、04：报告、成效及视频 | 后续阶段，当前不标完成 |
| DEL-02、05、06、07：开发证据、源码文档及技术路线 | 各工单留记录，15 汇总 |

## 评审项

M0 已获实施授权；后续仍需按用户选定工单执行。08 的材料处理与备课、11 的复核若在实施勘探后过大，应再分成可独立演示的行为，而非跨层半成品。下一执行者入口见 `../handoff/next-agent.md`。
