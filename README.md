# 班级助手

面向教师的 Windows 本地工作台。导入一次学生名单与考试成绩，即可用于点名、成绩分析、座次、值日和学生档案；备课与智能对话可按需接入模型服务。

## 给教师

免安装包完整解压后，双击根目录的 **启动工作台.cmd**。新建班级，再点击首页的 **导入资料**；保存前可以核对名单、成绩和同名学生。

- [快速上手](docs/handoff/redesigned-workspace-guide.md)
- [教师使用手册](docs/submissions/USER_MANUAL.md)
- [免安装使用说明](docs/submissions/INSTALLATION_MANUAL.md)

班主任首页按常用任务提供八个入口。姓名点击后打开学生档案，集中查看该生的成绩、点名和成长记录。模型服务需要由交付人员配置；名单、点名、统计、座次、值日和已保存资料可在本地使用。

## 给开发与维护人员

开发环境为 Windows x64 和 Node.js 24.x，最低 24.14.0。

```powershell
rtk npm ci
rtk npm run dev
```

源码按职责组织：

| 目录                             | 内容                                 |
| -------------------------------- | ------------------------------------ |
| `src/renderer/features/homeroom` | 班主任首页、统一导入和学生档案       |
| `src/renderer`                   | 其余教师页面、导航和界面样式         |
| `src/core`                       | 数据库、业务规则、文件解析与模型调用 |
| `src/main`                       | 桌面窗口、预加载脚本及受限接口       |
| `src/shared`                     | 前后端契约与校验                     |
| `tests` 与 `scripts`             | 自动检查、桌面流程与打包             |
| `docs/submissions`               | 教师文档及比赛材料源文件             |
| `docs/handoff`                   | 交接说明和各版本验证记录             |

常用检查与免安装打包：

```powershell
rtk npm run check
rtk npm run test:desktop
rtk npm run dist:portable
```

桌面测试前须完成构建；不要同时构建和测试同一份 `dist`。测试使用隔离目录中的合成资料，截图和报告位于 `output/playwright`。RTK 是此工作区的命令包装工具，不是客户端运行依赖。

- [当前版本说明](docs/handoff/current-delivery-notes.md)
- [开发与维护说明](docs/submissions/HANDOFF_AND_MAINTENANCE.md)
- [项目说明](docs/submissions/PROJECT_OVERVIEW.md)
- [比赛报告](docs/submissions/AGENT_DEVELOPMENT_AND_APPLICATION_REPORT.md)
- [演示视频脚本](docs/submissions/DEMO_VIDEO_SCRIPT.md)

Word 文档由 `scripts/generate-delivery-docs.py` 生成，需要开发环境安装 `python-docx`。生成后须渲染并检查分页，再执行免安装打包；客户运行软件不需要 Python。

业务数据库默认位于当前 Windows 用户的应用数据目录，不随程序文件夹移动。升级前在应用内导出备份；换电脑通过备份恢复，模型凭据另行配置。业务数据库未加密，模型凭据采用 Windows 系统保护。合成测试结果不代表真实教学成效；客户目标电脑仍需实际验收。
