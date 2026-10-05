# 班级管理本地智能体（Class Manager Agent）安装与部署手册

**适用人员**：教育信息化管理员、任课教师、教研员、二次开发技术人员  
**适用系统**：Windows 10 / Windows 11 (x64)  
**技术栈**：Electron + Node.js + React + Vite + TypeScript + SQLite  

---

## 一、 系统环境要求

### 1.1 硬件基本配置
| 硬件项 | 最低要求 | 推荐配置 |
| :--- | :--- | :--- |
| **处理器 (CPU)** | Intel Core i3 / AMD Ryzen 3 双核以上 | Intel Core i5 / AMD Ryzen 5 四核及以上 |
| **运行内存 (RAM)** | 4 GB | 8 GB 或 16 GB |
| **磁盘存储空间** | 空闲空间 2 GB 以上 | 固态硬盘 (SSD) 空闲空间 5 GB 以上 |
| **显示分辨率** | 1280 × 720 (支持缩放) | 1920 × 1080 (100% 缩放体验最佳) |

### 1.2 软件与运行依赖
- **操作系统**：Windows 10 / Windows 11 (64位简体中文版)
- **开发与构建依赖**（若从源码编译）：
  - Node.js: **v20.x 或 v24.x** (推荐使用 v24.14.0 LTS)
  - 包管理工具: **npm v10.x 及以上**
  - Git (可选，用于拉取源码)

---

## 二、 快速安装与运行（针对终端教师）

### 2.1 方式一：独立免安装绿色版（开箱即用）
1. 解压项目发布的绿色免安装包 `class-manager-win-unpacked.zip` 至任意本地磁盘（如 `D:\ClassManager\`，请避免路径中包含特殊字符）；
2. 进入目录，双击运行主程序 `Class Manager.exe`；
3. 系统将自动在本地安全数据目录初始化 SQLite 数据库，并直接进入主工作台界面。

### 2.2 方式二：标准桌面安装包 (NSIS 安装程序)
1. 双击运行安装程序 `Class-Manager-Setup.exe`；
2. 按照向导提示选择安装目录（支持非管理员权限安装到当前用户目录）；
3. 安装完成后自动在桌面和开始菜单生成快捷方式，勾选“启动 Class Manager”即可完成初次引导。

---

## 三、 从源码构建与开发者部署（针对信息化管理员）

若需要复现开发环境或二次定制，请参考以下标准化部署步骤：

### 3.1 获取源码与安装依赖
```powershell
# 1. 切换至工作空间
cd H:\WorkSpace\class-manager

# 2. 安装项目锁定版本的 npm 依赖 (建议使用 clean-install)
npm ci
```

### 3.2 启动开发调试环境
```powershell
# 启动热重载开发模式 (自动编译并打开 Electron 窗口)
npm run dev
```

### 3.3 生产构建与代码质检
在打包前，可运行全套自动化测试和代码规范检查，确保代码 100% 符合交付标准：
```powershell
# 1. TypeScript 类型检查
npm run typecheck

# 2. ESLint 规范审查
npm run lint

# 3. 代码格式检查
npm run format:check

# 4. Vite 生产前端构建
npm run build

# 5. 执行端到端黑盒测试套件 (验证全部业务与桌面生命周期)
npm run test:desktop
```

### 3.4 打包生成可分发桌面程序
```powershell
# 编译并生成免安装绿色目录 (output/release/) 与安装程序
npm run package
```
打包成功后，产物位于 `output/release-audit15/win-unpacked` 目录下，直接分发该目录即可在任何相同架构的 Windows 电脑上独立运行。

---

## 四、 国产生成式大模型配置指引

班级管理智能体在离线状态下可完整使用所有名册管理、座位编排、值日轮换、考勤点名、成绩统计等本地功能。若需启用“业务对话 Copilot”与“学情智能诊断”等高级生成功能，需在界面中配置国产大模型 API Key。

### 4.1 获取国产大模型 API Key
- **DeepSeek**：登录 [DeepSeek 开放平台](https://platform.deepseek.com/)，在“API Keys”页面创建密钥（支持 DeepSeek-V3 与 DeepSeek-R1）。
- **火山引擎豆包 (Doubao)**：登录火山引擎控制台，开通“方舟大模型服务平台”，获取 API Key 与 Endpoint ID（支持 Doubao-pro-32k 等）。
- **月之暗面 (Kimi)**：登录 [Moonshot AI 开放平台](https://platform.moonshot.cn/)，在开发者中心生成 API Key。

### 4.2 在软件中绑定配置
1. 启动软件，在左侧导航栏点击 **【系统设置】 -> 【模型设置】**；
2. 选择要启用的供应商标签（DeepSeek / 豆包 / Kimi）；
3. 将复制的 API Key 粘贴至密钥输入框；
4. 点击 **【保存并测试连通性】** 按钮；
5. 系统将向官方接口发起轻量级文本与视觉通道握手。测试通过后，显示绿色状态标识“本地安全凭据已就绪”，配置即刻生效。

> **安全提示**：输入的 API Key 将使用 Windows 系统底层安全凭据库（DPAPI）进行加密存储，不会明文存储在任何配置文件中，也不会上传至任何第三方服务器。

---

## 五、 数据存储位置与迁移备份

### 5.1 数据本地存储目录
软件默认在用户的本地应用数据目录下建立受保护的存储区：
- **配置文件与工作区**：`%APPDATA%\class-manager\`
- **本地 SQLite 数据库**：`%APPDATA%\class-manager\database.sqlite`
- **备课与教学资料库**：`%APPDATA%\class-manager\materials\`

### 5.2 数据一键备份与迁移恢复
1. **备份导出**：进入 **【系统设置】 -> 【数据与维护】**，点击 **【导出完整备份】**，系统将当前所有班级名册、考分、座位表、值日历史与备课资料打包为带有防篡改校验码的 `.cmbackup` 压缩包。
2. **恢复还原**：换机或重装系统后，在新机器上点击 **【从备份恢复】**，选择此文件，系统核对哈希无误后一键完整还原，保障数据平滑无缝迁移。

---

## 六、 常见问题排查与技术支持

| 异常现象 | 潜在诱因 | 解决方案 |
| :--- | :--- | :--- |
| **双击 EXE 无反应** | 杀毒软件误拦截或缺少 VC++ 运行库 | 1. 检查 Windows Defender 或第三方安全软件的拦截日志；<br>2. 安装微软官方 VC++ 2015-2022 Redistributable (x64)。 |
| **模型连通性测试报网络错误** | 校园网代理拦截或电脑未连接外网 | 1. 确认当前网络可正常访问外网；<br>2. 若在学校局域网环境，请联系网管在网关防火墙将 `api.deepseek.com` 或对应模型域名加入白名单。 |
| **npm run dev 报错** | Node.js 版本过低或依赖损坏 | 执行 `node -v` 确认版本在 20.x 或 24.x 以上；执行 `npm run clean && npm ci` 重新拉取依赖。 |

---
*(安装与部署手册完)*
