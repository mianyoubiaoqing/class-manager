# 班级助手维护与开发说明

本说明面向交付和维护人员。教师日常操作请阅读使用说明目录中的手册；开发与历史验收证据保留在完整源码中。

## 源码入口

src/main 负责桌面窗口、文件选择和受控接口。其中 src/main/preload.ts 暴露桌面接口，src/shared 定义契约，src/core 实现本地业务与 SQLite。

src/renderer/features/homeroom 放置统一资料导入、学生目录和档案小窗；features/teaching 放置当前班主任工作台和日常记录面板；features/resources 放置学科教学资源库。App.tsx 负责应用状态、区域导航和已有弹窗。

scripts 包含构建、打包和桌面验证；tests 包含自动化测试。docs/submissions 是比赛及用户文档源码，docs/handoff 保留专项实现和验收记录。历史验收记录不作为当前教师操作手册。

## 开发和检查

使用 Node.js 24.14 或兼容的 24.x 版本，依赖以 package-lock.json 为准。运行 npm ci 安装依赖，npm run dev 构建并打开桌面程序。

修改后运行 npm run typecheck、npm run lint、npm run format:check 和 npm test，再运行 npm run build。桌面回归入口为 node scripts/desktop-smoke.mjs，新版共享资料流程为 node scripts/shared-class-data-smoke.mjs。这些测试使用独立合成数据，不应指向客户的数据目录。

班主任工作台契约在 src/shared/teaching-workbench.ts，事务与校验在 src/core/teaching-book.ts。新增资源库契约和目录在 src/shared/resource-library，存储在 src/core/resource-library.ts，原生文件与导出通过 Main 和 worker 处理。数据库版本 14，编辑记录采用版本检查与请求去重；附件绑定教材章节，原始字节存入现有附件库，随备份恢复。旧库先保留副本再事务迁移。新增界面回归入口为 scripts/teaching-ui-smoke.mjs 和 scripts/resource-library-ui-smoke.mjs。

WorkBuddy MCP 服务位于 src/main/workbuddy-bridge.ts，连接器位于 src/main/mcp-stdio.ts。服务只监听 127.0.0.1 随机端口，要求本机令牌，拒绝网页 Origin；查询直接返回，修改进入本地确认队列。令牌文件位于 Electron userData 下的 workbuddy-connection.json，退出删除，不应纳入交付。资源目录自带 mcp-stdio.cjs，通过 Electron 的 Node 模式运行，无需另装 Node。

自动注册位于 src/main/workbuddy-registration.ts，检测当前用户 Local Programs 和 Program Files 下的 WorkBuddy/WorkBuddyAI 桌面端，合并当前用户 .workbuddy/mcp.json。保留其他服务、备份原字节、重复注册不重写；配置损坏和同名非本项目服务停止并报错。不读写 WorkBuddy 的授权文件，不强制重启它。首次第三方授权及必要的重新打开由用户在 WorkBuddy 完成；连接状态以本机 MCP 活动检测为准。

群通知通过教学记录 kind=notice 保存标题、日期和正文。MCP teaching_records 查询草稿，propose_teaching_record 形成修改方案；本地 saveTeachingRecord 和 deleteTeachingRecord 执行经确认的写入。当前不提供实际发送或已发送状态；后续发送渠道应单独实现。

免安装打包使用 npm run dist:portable。打包器检查源码、文档和程序哈希，并验证解压后的程序。Word 文档修改后需要重新生成及检查，转换清单中的哈希必须与文件一致。

## 模型配置

在系统设置的模型连接页，由交付人员打开设置，选择供应商并配置地址、模型和凭据。模型账号不得写进源码或交付包。网页平台登录不能替代 API 凭据。

连接检查和在线生成会实际请求供应商。HTTP 401 应检查凭据；格式修正重试不能解决身份验证失败。真实模型效果和费用按实际账号核对。

## 数据维护

应用实际数据目录显示在数据与备份页，程序包与数据库分开保存。维护前先导出 .cmbackup，并保存、退出应用。备份恢复会校验内容并保留恢复前副本，模型凭据不随业务备份迁移。

纯净测试使用 CLASS_MANAGER_DATA_DIR 指定独立目录。不要在应用运行时删除数据库文件，也不要把测试目录设置为客户目录。

## 排查问题

记录版本、操作步骤、错误编号和是否可以重复出现，再导出诊断。按具体模块读取 docs/handoff 的记录和对应测试，不依靠历史 README 中的通过数量判断当前构建。

界面变更要检查空名单、长姓名、重复姓名、多班级切换、窄窗口、未保存阻止导航和重启。成绩导入保留预览、明确身份匹配及原子保存；简化界面时不要删除这些业务约束。
