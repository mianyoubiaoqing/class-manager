# 16 多供应商开发交接

2026-10-02；实施、最终全仓、实际开发与独立包验证已完成，最终双轴证据复审通过，16整单关闭；接续17。

设计、官方来源、操作说明见[多供应商实现](../planning/model-providers.md)。入口文件：`src/core/model-runtime.ts`、`src/shared/model-providers.ts`、`src/core/deepseek/client.ts`、`src/main/main.ts`及四个业务runner、`src/renderer/ModelSettingsPage.tsx`。管理桥接124项、Schema11，无新增业务表。

固定基线`output/16-model-baseline-9Zm8IC`共377文件；差异生成器将仅输出16的变更，不覆盖13/14证据。全仓未提交工作与历史产物保留。

最终全仓57个测试文件、965项测试及格式/类型/Lint/构建通过。开发与修正独立包均通过设置页验证，外部请求0；两套通用桌面各10次重开通过。16份证据共508551字节已归档到`docs/handoff/evidence/16-*`，源与归档哈希一致；清单为`output/16-evidence-manifest.json`。

最终候选`output/release-audit16-corrected/win-unpacked`；实际测试副本`C:/Users/flow032417/AppData/Local/class-manager-providers-audit16-OADq8c`。82个复制文件及19项dist/ASAR内容身份匹配。EXE SHA256 `010326dc4b869833983b59eeb0c62715649959057cb66d243f2c157cce6e94ee`，ASAR SHA256 `fae540449d476bb57a406473401ebc90d6ad0bcf92175bf6d5825fc8cf5b5971`。详见[验收证据](model-providers-acceptance.md)及[包清单](evidence/16-package-manifest.json)。

核心定向测试覆盖确切传输、3供应商隔离、CAS版本、单次token、坏返回、HTTP零重试、取消、忽略取消的传输超时、重复调用ID/完成、凭据不可用、旧Key及Schema10迁移回滚。实际Main三供应商阅卷覆盖成功/取消/删除Key，另外三项业务经持久历史验证provider/model/prompt/usage。桌面脚本`scripts/providers-ui-smoke.mjs`覆盖实际Renderer/Preload/Main/Worker/SQLite/安全存储，只有合成Fetch替身；课堂拒绝全部9项新增操作。

设置是可用流程及预设，没有配置用户真实账号。豆包Model/Endpoint ID仍须用户本地填写；图像栏必须对应已开通视觉型号。真实连接检查未执行，能力显示未验证。没有自动重试、自动回退或学生资料外发。第15号仍须最终安装及用户独立接手，维护起算待定。
