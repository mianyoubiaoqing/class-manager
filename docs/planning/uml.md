# UML 领域类图

日期：2026-09-29。状态：概念模型草案，不是数据库迁移或已实现的类。

类名采用稳定英文标识，解释采用中文；图中省略通用时间戳、审计字段和外键细节。组合关系表示版本内对象的业务归属，不意味着允许物理级联删除已引用历史。属性未声明完整类型，实施时应使用明确类型与运行时校验。

## 1. 班务

可编辑图源：[classroom.mmd](diagrams/classroom.mmd)；缩放查看：[SVG](diagrams/classroom.svg)。

![班务类图](diagrams/classroom.png)

- `Classroom / Student / Enrollment`：班级、学生、成员关系。学生转班不换身份，历史安排继续指向当时成员关系。
- `SeatLayoutRevision / Seat`：布局版本及座位；布局修改不能改变已有座位计划。
- `SeatingPlan / SeatAssignment`：计划版本与逐人位置，包括锁定状态。
- `DutyPlan / DutyGroup / DutyMember / DutyAssignment / DutyPostAssignment`：当期计划、临时组、成员快照、日期轮换、岗位到人；临时替换作用于具体安排，不改写整期组员。
- `Countdown`：班级可配置目标日与时区。

额外约束：已确认座位计划中每名应安排成员恰好出现一次，每个可用座位最多一人；成员必须属于该计划班级及有效期间。已确认值日计划中组员必须有效且组不为空，同一成员不能同时占用冲突岗位。岗位安排通常来自当日轮值组，教师可明确指定有效成员作临时替换；不得因此改变其他日期。图中 `0..*` 允许尚未填完的草稿，不表示空草稿可确认。

## 2. 评价与成长

可编辑图源：[assessment.mmd](diagrams/assessment.mmd)；缩放查看：[SVG](diagrams/assessment.svg)。

![评价与成长类图](diagrams/assessment.png)

- `Exam / ExamSubject`：考试及科目、满分和精度；学校总分/选科规则另按成绩规格保存。
- `ScoreRevision / GradeEntry`：某考试科目的一次确认快照及逐生记录。成绩更正形成新版本，`status` 区分有效、缺考、缺失及未选考，非有效状态不用零替代。
- `AnswerSubmission / SourceAsset`：绑定学生与考试科目的答卷版本、原材料及页序。材料复用不等于答卷身份自动确定。
- `RubricVersion / QuestionRule`：已确认评分细则与逐题规则；模型不得改写满分或题目覆盖范围。
- `GradingDraft / QuestionAssessment / GradingReview`：建议版本、逐题证据与教师确认。确认后内容冻结，修订须重新审核。
- `GrowthEntry / SummaryDraft`：事实和正式档案条目、待审总结。总结的来源与其确认后生成的条目是不同关联。

发布约束：每份复核记录最多产生一次入分版本；一个入分版本可源自单份复核，也可以来自人工表格导入而没有复核来源。初版不做多份复核的原子批量发布，逐份发布须报告部分完成状态。快照中只有该学生被更新，其他成绩保留，预期版本冲突则暂停。

总结约束：来源可以为空，但不能凭空生成有事实断言的总结。成绩引用定位到确切版本和该成员条目；来源发生更正须提示过期。正式总结条目不可同时作为其自身草稿来源，防止循环引用。

## 3. 教学

可编辑图源：[teaching.mmd](diagrams/teaching.mmd)；缩放查看：[SVG](diagrams/teaching.svg)。

![教学类图](diagrams/teaching.png)

- `SourceMaterial / MaterialRevision / SourceReference`：资料、不可变版本、页码或章节引用。
- `LessonPlan / LessonRevision`：备课主题与保存版本。版本包含教案环节 `LessonSection` 与课件页 `Slide`。
- `ExportArtifact`：指定内容版本与模板版本的导出记录，不是重新生成的内容。
- `TeachingSession`：某班级基于指定备课版本的一次课堂展示及进度，不表示学生掌握情况。

展示约束：`teacherNotes` 默认不出现在课件或课堂展示中。课件内容保存时执行展示校验，教师明确选择答案的展示时机。已开始的课堂不会因其他窗口修改草稿自动更换版本。

## 4. 图外约束

任务队列、凭据、备份清单、迁移、审计以及 DeepSeek/平台 Adapter 属于工程结构，不强行放入业务类图。职责及状态规则见[架构](architecture.md)。历史版本原则不意味着永久保留所有数据，未来真实业务启用前须另定留存、删除及备份清理规则。

自动生成的 SVG 与 `.mmd` 图源配套维护；渲染通过只能证明图源可处理，不能证明领域规则或实现正确。工单修改概念关系时同时更新词汇表、图源、图片与规格。

## 5. 渲染记录

2026-09-29 使用 Mermaid CLI 12.0.0 生成三份 SVG 和三份 PNG，并查看 PNG 检查类名、属性和连线。采用[固定渲染配置](diagrams/mermaid-config.json)改善关系标记的可读性；关系较多时使用 SVG 放大，并以图源和上文约束核对。

在仓库根目录复现单图 SVG 的已执行命令如下；另两图替换文件名即可。此命令只生成文档图示，不是应用构建或测试。

```powershell
rtk npm exec --yes --package=@mermaid-js/mermaid-cli@12.0.0 -- mmdc -i docs/planning/diagrams/classroom.mmd -o docs/planning/diagrams/classroom.svg -c docs/planning/diagrams/mermaid-config.json -b white
```

PNG 使用同一图源及配置，将输出扩展名改为 `.png`；本轮班务、评价与教学分别使用 `--size 2400`、`--size 2800`、`--size 2000`。初次执行可能下载渲染依赖；它不是客户端的运行依赖。
