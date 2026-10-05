# 免安装分发与外部办公平台接入调研

查阅日期：2026-10-03。范围：用户提出的免安装使用方案，以及由应用制作课件、由已有 WPS/Office 编辑和展示的方向。本文只调研；没有修改应用、打包配置、数据目录、系统关联或办公软件，没有运行新的兼容性验收。

## 结论

建议近期提供完整的 Windows 解压运行 ZIP，保留当前 Electron、本地 SQLite 和既有数据维护流程；其含义是“无需运行安装向导”，并非“无需下载运行时”“数据随 EXE 携带”或“电脑不产生任何文件”。单文件 portable EXE 是另一种分发形态，但 electron-builder 的 portable 本身使用 NSIS 模板并解压到临时目录，因此不能据此承诺避开此前的 TEMP/NSIS 故障。[S1、S2、R1]

课件方面，建议应用生成确定版本的原生 PPTX，教师确认后交给已安装的 WPS 演示或 PowerPoint 编辑、放映。当前代码已经具备 PPTX 生成、保存和调用系统默认关联打开的基础。先复用这一流程，再按实测结果添加“直接放映”适配器；无需为了完成该需求先实现一套 Office 级编辑器。[S5、S6、R3]

浏览器/PWA、局域网服务和托管网站可以满足不同程度的“客户端免安装”，但都是独立的架构工程；不能把现有开发网页发布出去，就宣称 Node SQLite、凭据保护、材料工作进程、本机打开软件及打印功能原样可用。[R1、R2；浏览器替代能力见 S7—S10]

## 证据的含义

- **官方事实 S**：来自维护方文档或官方源码，证明接口/机制存在，不证明本应用已接入或在目标软件通过。
- **仓库事实 R**：只读核对当前源文件和已有验收记录，是本应用的现状。
- **工程建议/推论**：基于 S/R 的取舍；尚未作为新方案实现或实测。

官方页面可能随维护方更新；以下接口事实以 2026-10-03 查阅内容为准。未给出工期、安装包新体积、性能或供应商收费承诺。

读取方式：本次 `web.run` 多次返回空输出，未提供可引用的网页 ID；随后以只读 HTTP 请求直接获取下列维护方页面，核对 HTTP 200、页面标题及支持该结论的正文。S2 的 GitHub HTTP 请求失败，改读本仓库锁定依赖中的同一官方模板，未将网络失败冒充成功读取。本文保留直接来源地址，未伪造浏览器引用 ID。

后续复核：主代理再次调用网页打开及搜索，仍无可读输出或引用 ID；未把此次检索计为成功证据。锁定 26.15.3 的行为以本地官方依赖源码为准，未以 master 替换已锁定版本的事实。

## 现有架构和验证边界

**R1：** `package.json` 使用 Electron + React + TypeScript，`npm run pack` 已包含 `electron-builder --win --x64 --dir`，正式分发配置当前是 NSIS。`src/core/database.ts` 使用 `node:sqlite` 的 `DatabaseSync`；`src/main/main.ts` 使用 Electron IPC、原生对话框、打印、`safeStorage`、子进程及 `shell.openPath`。这些是桌面应用依赖。

**R2：** `main.ts` 默认通过 `app.getPath('userData')` 定位数据，业务资料位于其 `workspace-data` 子目录；配置、模型凭据和用量另位于同一用户数据根。现有 `CLASS_MANAGER_DATA_DIR` 环境变量可以在启动时覆盖 `userData`，主要用于隔离运行；它不是已设计并验收的“随身 U 盘模式”。`src/renderer/browser-preview-shim.ts` 仅在开发模式装配内存假数据和模拟接口，不能用作生产后端。`docs/planning/architecture.md` 要求由单一应用侧协调事务、附件、备份和恢复，打包版默认不监听 HTTP 端口。

**R3：** `office-exporter.ts` 从 Worker 的确切冻结版本生成文件，保存后产生会话内打开凭据；再次打开校验工作区 epoch 和文件指纹。`main.ts` 的 `openLessonOffice` 调用 `shell.openPath`。`office-files.ts` 对新文件使用硬链接发布，已有文件使用重命名；现有验收范围是本地 NTFS，不能据此声称 exFAT/FAT U 盘或网络共享导出通过。

**R4：** `docs/handoff/office-export.md`、`office-acceptance.md` 记录 WPS Office 12.1.0.28505 的 DOCX/PPTX 修改、另存和重开，以及 70 页 PDF 渲染检查通过；Microsoft Word/PowerPoint 当时未安装，未实测。WPS COM 只被验收脚本使用，产品生成路径依靠锁定的 `docx` 与 `pptxgenjs`，不依赖 Office COM。

## 免安装方案比较

| 方案 | 用户怎样使用 | 对现有业务的影响 | 数据、升级与主要限制 | 建议 |
| --- | --- | --- | --- | --- |
| 完整解压 ZIP | 完整解压应用目录，双击目录内 EXE | 最小；可保留当前 Main/Worker/SQLite/原生库 | 默认仍写当前用户 AppData；换目录不等于迁移数据。升级应退出后解压新版本，避免覆盖正在使用的 DLL/ASAR；不能在压缩包浏览视图只拖出 EXE运行。[R1、R2；路径规则 S3] | 首选；另做无安装冒烟后交付 |
| electron-builder portable 单 EXE | 双击一个自解压启动文件 | 可保留桌面运行模型，新增分发验证 | 官方配置明确资源解压到 TEMP/$PLUGINSDIR；源码启动解压后的程序并在结束后清理。启动需要临时空间，不能保证规避 NSIS 临时写入问题。portable 环境变量不会自动令本应用改变 `userData`。[S1、S2、R2] | 作为后续备选，不能宣传“彻底无临时文件” |
| 纯浏览器网页/PWA | 打开网址；PWA 安装为可选体验 | 需实现浏览器持久化和适配器，替换 Node/IPC/工作进程；文档库可另评估浏览器生成路径 | PWA 可缓存前端离线运行，但不等于云模型离线可用。SQLite WASM/OPFS 可做浏览器库，需明确 VFS、Worker 和锁。站点存储受额度、清理及用户配置影响。[S7—S10] | 仅当用户明确要求“只打开网址”时另立项目 |
| 本机后端 + 浏览器界面 | 运行免安装服务包，浏览器访问回环地址 | 可复用更多 Node 用例，但 Electron API 要替换；需新 HTTP/流式任务通道 | 仍下载并运行本机程序，不能称作零本机组件；要处理服务关闭、随机端口、访问令牌、Origin/CSRF、单实例和更新。浏览器不能因此获得任意本机软件控制。[R1、R2；工程推论] | 成本高于 ZIP，本次不优先 |
| 托管网页/校内服务器 | 客户端打开网址，服务端部署 | 需账户、授权、租户/学校隔离、并发、上传下载、服务端凭据与持续运维 | 数据迁到服务器；离线业务和本机打印/Office 打开另做适配。客户端免安装不意味着没有部署/运行费用或安全维护。[R1、R2；工程推论] | 若有多人共享/跨设备需求再评估 |

### “无需安装”和“数据可随身带走”应分开决定

默认建议先做**程序免安装、数据仍存当前 Windows 用户目录**。已有安装版与同产品解压版可能指向同一数据根；发布时必须固定产品身份并明确复用/隔离策略，避免两个版本同时修改同库。[R2；S3；工程建议]

若另做“程序 + 数据随身目录”，须先验证本地可写普通目录、单实例、异常关机、写入锁、迁移备份、容量不足和设备拔出；不要把业务库放到单文件启动器会删除的临时解压目录。当前 NTFS 导出约束意味着典型 exFAT U 盘需专门处理，而非仅改一个数据路径。[R2、R3；S2；工程建议]

`safeStorage` 在 Windows 使用 DPAPI，保护与 Windows 用户凭据相关；它不防同一用户身份运行的其他程序。换账号/电脑不得承诺复制加密凭据即可继续调用模型；现有业务备份不包含凭据，换机重新配置供应商 Key 更符合当前契约。[S4、R2；`architecture.md` 备份约束]

不论安装版或免安装版，数据库升级、附件和恢复保护仍需执行。回退旧 EXE 不等于能读取升级后的数据库；先备份，再验收对应版本恢复。删除程序目录也不等于删除用户数据。[R2；工程建议]

### 浏览器能力的准确边界

SQLite 官方 WASM 提供 OPFS 持久化方案，证明浏览器可运行 SQLite，而非证明本项目现有 `node:sqlite` 可不改运行；不同 VFS 的并发和部署要求不同。[S8]

文件选择/保存在支持的浏览器中可用 File System Access API，但需要安全上下文、用户手势和权限，不能用它代替 Electron 的任意本机执行能力。当前导出流程是先生成、再弹保存对话框，浏览器移植时也需重新考虑用户手势时限。[S9、R3；工程推论]

浏览器持久存储可降低自动驱逐风险，授权结果并不保证始终成功，用户仍能删除站点数据；因此需应用内备份导出和迁移，不能把浏览器缓存当作教师数据的唯一保障。[S10；工程建议]

## 复用 WPS/Office 的接入层级

| 层级 | 能做什么 | 官方证据/实际边界 | 本项目取舍 |
| --- | --- | --- | --- |
| 文件协作 | 生成 PPTX/DOCX → 系统默认软件打开 → 教师编辑/展示 | Electron `shell.openPath` 用桌面默认方式打开，成功返回并不证明已经全屏放映。[S5] 本项目已有有限打开凭据与 WPS 编辑证据。[R3、R4] | 首选；保持生成与编辑/展示分工 |
| PowerPoint 固定启动参数 | 打开确定文件即进入放映 | Microsoft 官方列出 `POWERPNT.exe /S "Presentation1.pptx"`；必须核验实际安装位置，不能假设每台电脑固定目录。[S6] | 后续独立 Windows 适配器；本机尚无新 PowerPoint 实测 |
| PowerPoint 桌面 COM | 打开文件、配置放映、翻页、读取状态等 | 官方对象模型含 `SlideShowSettings.Run`，返回 `SlideShowWindow`。[S11] 这不等于不依赖已安装 Office，且存在弹窗/实例所有权/位数/阻塞处理成本。[工程推论] | 仅在确有“应用控制外部放映”需求时增加；不替换 PPTX 生成器 |
| Office Add-in/PowerPoint JS | 在 PowerPoint 内提供任务窗格并操作宿主文稿 | 加载项运行于 Office 宿主的 JS 对象模型；支持程度取决于客户端与 requirement set，需 manifest/运行时检测。[S12、S13] | 适合长期“在 PowerPoint 内使用 Agent”；不是 Electron 直接获得 COM 全部能力的捷径 |
| WPS 桌面 JS 加载项 | 在 WPS 内调用文稿/放映对象 | 官方 WPP `SlideShowSettings.Run()` 支持放映；官方可用性说明要求安装包含加载项能力及相关配置。[S14、S15] | 独立 WPS 插件/适配器路径；不能承诺全部个人版/企业版默认开启 |
| WPS COM/外部自动化 | 可能在指定桌面版本控制 WPS | 本仓库只证明已有验收脚本在 WPS 12.1.0.28505 工作。[R4] 本次未取得足以承诺全部版本、位数、注册名和完整 COM 契约兼容的官方证据 | 能力探测 + 指定版本试点；不要直接声称兼容所有 PowerPoint COM 接口 |
| WPS WebOffice/平台 API | 网页中在线预览/编辑/放映及协作 | 官方文档分别提供在线 PPT 放映 API及服务端回调，需 AppId/AppSecret、签名、用户 token、可由 WebOffice 访问的回调服务。[S16、S17] | 云接入项目；不能当作单机 WPS 文件关联的另一名字 |

Microsoft 当前明确不推荐/不支持从无人值守、非交互组件做 Office 自动化，并说明 UI 假设可能导致阻塞；即使存在专用无人值守许可，也不因此消除技术限制。因此不要为了未来网页版本，在服务器上无人值守启动 PowerPoint 来代替本项目现有 OOXML 生成器。[S18]

### 推荐用户流程与职责

建议流程：Agent 理解教学要求 → 制作并显示课件草稿 → 教师确认确切版本 → 应用生成/保存 PPTX → 教师点击“用 WPS/PowerPoint 打开”或确认放映 → 办公软件负责排版编辑、批注、动画、多屏和演讲者工具。生成文件本身不依赖已安装 Office；编辑/放映阶段依赖兼容的办公软件。[R3、R4；工程建议]

近期 UI 最小增量是把现有“打开刚保存的文件”能力带入对话产物卡，保留“保存 PPTX”“打开课件”和“展示范围”的可理解名称。回执只陈述“文件保存成功/已交给默认应用”，不能把系统打开成功伪装成“已进入放映”。[S5、R3；工程建议]

若实现“直接放映”，模型只能请求有限意图，例如已保存产物 token、目标软件枚举和播放模式；Main 解析凭据、核验文件指纹和受信软件路径，固定参数数组调用，不接受模型给出 EXE、任意路径、命令行或宏。正式保存、启动投影等仍展示具体范围并由教师确认；执行成功后应连续推进剩余任务，但下一项正式操作仍须单独确认。[R3及既有对话治理；工程建议]

外部软件修改后默认另存为外部文件，不自动覆盖数据库冻结版本。若今后要导入外部修改，需要单独定义导入、版本归属、冲突、字体/布局解析以及丢失对象的提示；不能通过“打开 Office”顺带承诺双向同步。[R3、R4；工程建议]

PPTX 的答案/教师备注必须在导出前确认。备注不在投影片画布不等于文件保密；分享文件仍可能分享备注。云 WebOffice 接入将文档交给外部服务，须单独处理授权、数据范围、令牌和日志，而不能只沿用本地打开许可。[R4、S17；工程建议]

## 后续可执行顺序（本次未实施）

1. 选择并交付免安装 ZIP，保持数据位置契约；验收首次启动、退出重开、同机安装版切换、手动升级、备份/恢复、导出及无开发工具运行。中文/空格路径、只读目录、TEMP 失败需实际检查。
2. 对话中复用有限 Office 导出/打开能力；记录确切版本和打开回执。没有软件关联、文件被编辑、凭据过期、取消保存、答案/备注范围须能明确反馈。
3. 以实际 WPS/PowerPoint 的版本、架构和显示设备为矩阵验证 PPTX 中文字体、长文本、表格、图片、编辑另存、演讲者备注和多屏。现有 WPS 证据不覆盖新版“直接放映”链路。
4. 仅在需要外部翻页/状态同步时选择 COM 或加载项试点。不得关闭不属于本应用的办公实例，不改变用户的默认文件关联或全局安全/宏设置。
5. 若后续要求浏览器免下载，再独立确定单机 PWA、校内服务器或托管服务，定义数据归属、用户账户、迁移、离线和 Office 适配；不要与 ZIP 分发混称一个方案。

办公软件/平台的安装授权、插件部署权和在线 API 计费必须按客户实际版本及采购契约核实。本文没有获得新的商业授权或报价，没有把客户已有 Office/WPS 许可解释为可重新分发它们的运行时；近期方案只调用用户已安装软件，分发包不携带办公软件。[工程边界；S15、S17、S18]

## 一手来源

- **S1** Electron-builder v26 PortableOptions：<https://www.electron.build/v26/docs/api/app-builder-lib.interface.portableoptions/>。TEMP/$PLUGINSDIR 解压目录、默认用户执行级别；也核对了当前文档 <https://www.electron.build/docs/api/electron-builder.interface.portableoptions/>，不是本项目已验证 portable 候选。
- **S2** Electron-builder 官方 `portable.nsi` 源码，本次实际读取的是本仓库锁定 26.15.3 依赖内 `node_modules/app-builder-lib/templates/nsis/portable.nsi`。可见 InitPluginsDir、TEMP 目录、portable 环境变量、ExecWait 和退出清理。上游定位地址为 <https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/nsis/portable.nsi>，本次该 GitHub HTTP 请求失败；结论根据本地官方依赖源码，而非声称已读 master。
- **S3** Electron app API：<https://www.electronjs.org/docs/latest/api/app>。`appData`/`userData` 默认目录及 `setPath`。
- **S4** Electron safeStorage API：<https://www.electronjs.org/docs/latest/api/safe-storage>。Windows DPAPI 及同一用户进程保护边界。
- **S5** Electron shell API：<https://www.electronjs.org/docs/latest/api/shell>。`openPath` 交给默认桌面方式打开及错误返回。
- **S6** Microsoft Office command-line switches：<https://support.microsoft.com/en-us/office/lifecycle/command-line-switches-for-microsoft-office-products>。PowerPoint `/S`；需要真实可执行文件路径。
- **S7** Microsoft Edge PWA 开发指南：<https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps-chromium/how-to/>。service worker 前端缓存和离线机制。
- **S8** SQLite WASM Persistent Storage Options：<https://www.sqlite.org/wasm/doc/trunk/persistence.md>。浏览器 Worker/OPFS/VFS 取舍。
- **S9** Chrome File System Access API：<https://developer.chrome.com/docs/capabilities/web-apis/file-system-access>。安全上下文、用户手势、权限和浏览器支持。
- **S10** Google web.dev Persistent storage：<https://web.dev/articles/persistent-storage?hl=en>，及 Offline data：<https://web.dev/learn/pwa/offline-data?hl=en>。持久授权、额度/驱逐与用户删除边界。
- **S11** Microsoft PowerPoint `SlideShowSettings.Run`：<https://learn.microsoft.com/en-us/office/vba/api/powerpoint.slideshowsettings.run>。
- **S12** Microsoft PowerPoint JS object model：<https://learn.microsoft.com/en-us/office/dev/add-ins/powerpoint/core-concepts>。
- **S13** Microsoft PowerPoint JS requirement sets：<https://learn.microsoft.com/en-us/javascript/api/requirement-sets/powerpoint/powerpoint-api-requirement-sets>。客户端/版本支持矩阵与运行时检测。
- **S14** WPS 桌面 JSAPI WPP `SlideShowSettings.Run`：<https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wpp/SlideShowSettings/member/Run>。
- **S15** WPS 加载项可用性：<https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/wps-addin-availability>。安装包功能和启用/部署配置。
- **S16** WPS 在线预览编辑 PPT 放映设置：<https://open.wps.cn/documents/app-integration-dev/docs-center/online-preview-edit/client/PPT/SlideShowSettings>。此 API属于在线 SDK，不能与桌面 JSAPI 混同。
- **S17** WPS WebOffice 服务端回调概述：<https://open.wps.cn/documents/app-integration-dev/docs-center/online-preview-edit/callback/summary>。AppId/AppSecret、签名、用户 token 与服务端可达要求。
- **S18** Microsoft 无人值守 Office 自动化注意事项：<https://learn.microsoft.com/en-us/office/client-developer/integration/considerations-unattended-automation-office-microsoft-365-for-unattended-rpa>。许可存在仍有交互假设与不支持的非交互服务器自动化环境。

仓库参考：`docs/planning/desktop-client-and-export.md`、`docs/planning/architecture.md`、`docs/handoff/office-export.md`、`docs/handoff/office-acceptance.md`、`package.json`、`src/main/main.ts`、`src/main/office-exporter.ts`、`src/main/office-files.ts`、`src/core/database.ts`、`src/renderer/browser-preview-shim.ts`。本次仅写入本文；上列源文件与既有文档只读。
