# 班级管理客户端

当前为 **M0 工程验证版**：Windows 单机、合成数据、无云模型调用。不是八项业务功能的完整初版。

## 运行

已有产物位于 `release/`：安装候选为 `Class-Manager-0.1.0-x64-Setup.exe`，免安装检查入口为 `win-unpacked/Class Manager.exe`。免安装运行时须保留整个 `win-unpacked` 目录，不能只复制 EXE。

开发环境为 Node.js 24.14.0（24.x）和 npm。依赖以锁文件为准：

```powershell
rtk npm ci
rtk npm run dev
```

`dev` 构建并打开 Electron；`start` 直接打开已有构建。打包运行不依赖 Node、开发服务器或 localhost 端口。普通终端未安装 RTK 时，可使用对应的 `npm` 命令；RTK 是本开发环境的命令包装工具，不是客户端依赖。

## 当前功能

- 创建/重命名班级，新增/修改学生，转班、停用与恢复在籍，保留成员关系历史。
- 搜索、筛选、分页；空名册可载入 2 班、100 人的虚构样例。
- SQLite 保存与重开；受限桌面接口及独立工作线程。
- 包含受管合成附件的一致备份，校验预览后恢复，保留并可回退恢复前副本。
- 脱敏诊断、版本不兼容拒绝打开、坏备份拒绝及工作线程超时保护。

## 文档

- [用户操作手册](docs/handoff/user-manual.md)：启动、名册、备份恢复与排错。
- [开发者交接](docs/handoff/developer.md)：实际模块、数据布局、扩展与检查。
- [后续执行与审计](docs/handoff/next-agent.md)：交给后续执行模型的工作入口和审计要求。
- [M0 验证记录](docs/handoff/m0-verification.md)：执行结果、环境与尚未验证项目。
- [后续完整规划](docs/planning/README.md)：架构、UML 与业务工单。

检查、桌面测试和打包命令在 `package.json` 中。常用完整检查：

```powershell
rtk npm run check
rtk npm run test:desktop
rtk npm run dist:win
rtk node scripts/desktop-smoke.mjs --packaged
```

先完成构建再运行桌面测试；不要同时构建和测试同一份 `dist`。自动测试只使用临时目录内的合成资料，桌面截图与报告在 `output/playwright/`。

## 限制

当前未配置代码签名，客户目标电脑、干净 Windows 环境的安装验收尚需完成；不要通过关闭安全防护安装。Linux/macOS 未验收。M0 尚无 DeepSeek 设置、成绩分析、备课/导出、阅卷、座位、值日、成长档案或设备接入。

数据和备份未做业务加密；Base64 不是加密。当前只允许合成验证。开发者负责首次部署及约定的 7 天维护，起算日期和客户账号归属仍待确认。
