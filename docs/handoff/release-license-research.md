# 15 确切版本许可通知调研

本报告记录许可修复前的锁文件及安装树快照；当前实施状态见[许可修复](release-license-remediation.md)，不能将原快照当成已替换的构建。

2026-10-02，只读一手来源调研。结论：**原四项均不能通过“补齐该确切版本的完整许可原文”闭合**。这表示本次查到的证据不足；不是断言历史上不存在授权。产品、锁文件、既有候选/归档/通知、16/17冻结差异未由本调研修改。证据单独存入 `output/license-research15/`。[S01][S02][S03][S04][E01]

## 原四项判定

| 确切版本 | 发布包证据 | 版本/上游绑定限制 | 完整通知判定 |
| --- | --- | --- | --- |
| binary 0.3.0 | 2012-05-11发布；40个普通文件；package.json和README只有MIT标签，没有完整许可/版权通知 | npm无gitHead；repository指向substack/node-binary，仓库、tags及master/LICENSE查询均404 | 未闭合 [S01][G01][E01] |
| buffers 0.1.1 | 2011-10-12发布；6个普通文件；package.json无license/licenses，README及源码无许可声明或完整原文 | npm无gitHead；repository指向substack/node-buffers，仓库、tags及master/LICENSE查询均404 | 未闭合，许可种类也未证实 [S02][G02][E01] |
| chainsaw 0.1.0 | 2011-07-17发布；7个普通文件；package.json只有MIT/X11标签，无完整原文 | npm无gitHead；repository指向substack/node-chainsaw，仓库、tags及master/LICENSE查询均404 | 未闭合 [S03][G03][E01] |
| https 1.0.0 | 2015-03-20发布；只有331字节package.json；ISC标签，main指向不存在的index.js，无README/LICENSE/源代码 | 作者元数据为hardus van der berg；无repository/gitHead；npm只有此一个版本 | 未闭合 [S04][E01] |

上述日期来自完整npm registry响应的 `time[version]`，不是从文件时间推断。四项registry的latest目前分别就是本表确切版本；不能借此推断任意镜像、新增LICENSE或别的项目的许可适用于它们。[S01][S02][S03][S04]

四个官方npm tarball均通过registry的SHA1/shasum及SHA512/integrity校验，integrity也与工作区锁记录一致。解出的全部普通文件逐一与当时node_modules对应文件SHA256相同；原始tarball及解出文件完整保留。因此“发布包缺完整通知”的结论对应实际安装版本，而不依赖当前GitHub默认分支。[E01][E02]

| npm tarball | SHA256 |
| --- | --- |
| binary-0.3.0.tgz | `940bc9b40fb2a875876e3ca1be3d05a7a419881e4201c76c83ffbb05568b6909` |
| buffers-0.1.1.tgz | `f8de49c60e467005182d9687b5d87775bbcec6385ac63220b7741327441deb6d` |
| chainsaw-0.1.0.tgz | `01586a6aa1d1174ae07aff69822d01e0704fe30f23ac22221c9b804bab976cfb` |
| https-1.0.0.tgz | `7d6cc44a6471377a9299371e4d207cd2607bbaf7bcca1b220c8bd6831fbbe645` |

仓库404是本次访问状态；无法区分删除、转移、私有化或其他原因。相同GitHub API下exceljs/exceljs返回200，控制请求已保存。substack作者网站可访问，但本次页面未提供与这三个确切包匹配的LICENSE或提交来源；https作者旧网站最终跳到域名出售页面，不能用作该包版权来源。未联系作者，也未发送外部消息。[G01][G02][G03][G04][E03]

## 后续移除缺项的技术可行性证据

这一部分只说明确切源码、接口和加载事实，不将“未执行npm包源码”视作完整许可通知，也不代替后续回归验证。[A01][A02][A03][N01]

### unzipper 0.12.5

官方npm版本响应给出 `gitHead=aaf77f0c7b4d29af500b0aa9c0e2aa2ade0a2618`，repository为ZJONSSON/node-unzipper。发布tarball包含1219字节完整LICENSE，包括Near Infinity Corporation的2012–2013版权声明及Ziggy Jonsson对该fork提交的声明。精确gitHead下的LICENSE与npm发布包LICENSE逐字节相同，SHA256均为 `b9e9abeaf8b92573dc28915d4948dbce30d55b30c688d109898b35e6105c4215`；tarball的SHA1/SHA512校验也通过。这是0.12.5自己的许可证据，未用于补写0.10.14或原三项的通知。[A01][E04]

0.12.5直接依赖为bluebird ~3.7.2、duplexer2 ~0.1.4、fs-extra 11.3.1、graceful-fs ^4.2.2、node-int64 ^0.4.0，没有binary/buffers/chainsaw。基于本次锁文件快照递归解析根node_modules/unzipper的16个包，依赖闭包亦不含原四项；完整路径/版本记录在verification.json。该闭包只对应本次工作区快照，后续改变锁文件须重新核查。[A01][E02][E04]

工作区根unzipper 0.12.5是开发依赖；ExcelJS 4.4.0实际锁到 `node_modules/exceljs/node_modules/unzipper` 0.10.14，后者直接依赖binary ~0.3.0，再引入buffers/chainsaw。因此仅观察根0.12.5存在，不能认定ExcelJS已经切换。ExcelJS声明的范围 `^0.10.11` 不接受0.12.5；如后续决定替换，需要明确改变解析并验证。[A01][A02][E02]

ExcelJS 4.4.0官方npm包源码中，搜索lib目录找到的unzipper入口在 `lib/stream/xlsx/workbook-reader.js`：第5行require；第82行 `Parse({forceStream:true})`；第83行输入流pipe；第88行读取entry流；第91行entry.path；第124行entry.pipe；第137行entry.autodrain。0.12.5的 `unzip.js:2` 保留Parse导出；`lib/parse.js:113` 创建PassThrough entry；第116行autodrain；第132行path；第159–160行处理forceStream并push entry。其同版README第269–281行提供相同接口组合的异步迭代示例。因此所需接口静态匹配，但ZIP边界条件、错误传播、内存行为以及业务结果仍需替换后的真实测试；本调研没有运行替换后的业务测试。[A01][A02][E04]

### https 1.0.0 与 Node 内建 HTTPS

PptxGenJS 4.0.1官方npm发布包的 `dist/pptxgen.cjs.js:4845` 明确动态 `import('node:https')`，第4894行调用所得对象的https.get。该源文件SHA256为 `873d182a8e2e1c0b5e522ef146117936b96b9b2024667bd4c1de59e2b031d27a`，与工作区实际安装文件相同。`node:`前缀指定Node内建模块；该路径不会加载 `node_modules/https` 的package.json.main。npm https 1.0.0的元数据依赖仍在PptxGenJS package.json/锁文件中，空源码事实不能自动消除分发清单中的缺项。[S04][A03][N01][E04]

本机Node v24.14.0的只读探测得到 `require.resolve('https') === 'https'`、`require.resolve('node:https') === 'node:https'`、`isBuiltin('https') === true`、两种require返回同一对象。此探测只佐证当前Node环境；不冒称已验证Electron打包后的所有导出或图片路径。后续若排除空npm包，仍需检查打包清单和PPTX导出/远程图片加载行为。[N01][N02][E01]

## 追加：0.12.5构建失败与0.12.3/0.12.4回退核查

2026-10-02后续实际回归显示：0.12.5的静态API匹配不能代表bundle通过。`output/15-license-reconciled-check.log`记录17个测试文件失败、41个通过；57项测试失败、915项通过、32项跳过。所示57项失败的共同原因是esbuild构建阶段无法解析 `@aws-sdk/client-s3`，不是这些业务断言已执行后判定错误。源代码定位为 `lib/Open/index.js:98` 的直接require；该调用位于 `s3_v3` 函数体，运行时按功能触发，仍会被bundler提前解析。原日志只读复制并固定SHA256 `4e354a6fe23ce119fd9e4362c506bf9bf2279500fa136116f9952d76beb8ab8e`，不覆盖原回归记录。[E05]

优先核查0.12.3，再核查0.12.4，结果均为**许可齐全、所需接口静态匹配，但不能解决当前bundle失败**。两版官方npm tarball的SHA1/SHA512均核验一致；各自gitHead下的完整LICENSE与各自npm包LICENSE逐字节相同，LICENSE SHA256均为 `b9e9abeaf8b92573dc28915d4948dbce30d55b30c688d109898b35e6105c4215`。[A04][A05][E06]

| 确切版本 | npm gitHead | 发布包SHA256 | 未声明加载 / bundle结果 |
| --- | --- | --- | --- |
| 0.12.3 | `d19c3fb9c1bbdce6e6bcb701ac65ddb071e1eb31` | `8c567c813888cbc8040b1e07a0db953b8ffbad5cb186a10a9f826eb7106036a1` | Open/index.js:98 require AWS SDK；隔离bundle失败 [A04][E06][E05] |
| 0.12.4 | `b8906c8c210ecce08962d3732ea32fd7e3072fe2` | `8cbf3038cc134305e0983bf35a50c2f0f834601a391716d89bcdb99045ee6cae` | 同一位置/加载；隔离bundle失败 [A05][E06][E05] |

两版直接依赖均为bluebird、duplexer2、fs-extra、graceful-fs、node-int64，没有binary/buffers/chainsaw；0.12.3的fs-extra范围为 `^11.2.0`，0.12.4固定为 `11.3.1`，其余范围见保存的元数据。这是确切发布声明，未将两版尚未安装的依赖树冒称为已验证锁闭包。[A04][A05][E06]

两版 `unzip.js:2` 导出Parse，而第5行也导出Open，所以常规包入口同时让bundler看到Open源码。ExcelJS所需Parse接口在两版仍位于 `lib/parse.js:113` 的PassThrough entry、116的autodrain、132的path、159的forceStream；该文件与0.12.5发布版完全相同。两版的 `lib/Open/index.js:98` 都包含未在dependencies声明的 `@aws-sdk/client-s3`。另外 `lib/Decrypt.js:6–7` 在老Node缺少Writable.destroy时条件加载readable-stream，包自身没有直接声明它；本次工作区存在该传递依赖，所以隔离探测没有因此报错。逐JS文件的51处字面量require/import记录及未声明外部加载清单存入older-alternative-inspection.json；这不声称已验证所有未来安装环境。[A04][A05][E06][E05]

实际隔离探测使用工作区esbuild 0.28.2和Node v24.14.0，入口分别为两个原始解出的 `unzip.js`，选项为bundle=true/platform=node/format=cjs/write=false，不添加AWS依赖、不改源码、不写产品bundle。两版均在Open/index.js:98复现 `Could not resolve "@aws-sdk/client-s3"`。探测利用本工作区现有依赖解析；结果足以排除“只回退到0.12.3或0.12.4即可消除这个构建阻断”的假设，不代替业务回归。未实施任何源码patch或新增SDK。[E05]

## 出处与校验

所有HTTP响应的原始字节、请求URL、最终URL、状态、抓取UTC时间、文件名及SHA256见 [capture-manifest.json](../../output/license-research15/capture-manifest.json)。首次39份响应及追加8份响应，共47份下载响应的SHA256全部再次核验一致。目录内容哈希见 [evidence-sha256.json](../../output/license-research15/evidence-sha256.json)，其自身不作自引用哈希；首次131项文件校验保留在verification.json，追加校验见followup-verification.json。[E04][E07]

- **[S01]** [binary 0.3.0官方元数据](https://registry.npmjs.org/binary/0.3.0)、[全部版本/时间](https://registry.npmjs.org/binary)、[发布包](https://registry.npmjs.org/binary/-/binary-0.3.0.tgz)。本地 `binary-version.json`、`binary-registry.json`、`binary-published-tarball.tgz`、`published/binary/`。
- **[S02]** [buffers 0.1.1官方元数据](https://registry.npmjs.org/buffers/0.1.1)、[全部版本/时间](https://registry.npmjs.org/buffers)、[发布包](https://registry.npmjs.org/buffers/-/buffers-0.1.1.tgz)。本地 `buffers-version.json`、`buffers-registry.json`、`buffers-published-tarball.tgz`、`published/buffers/`。
- **[S03]** [chainsaw 0.1.0官方元数据](https://registry.npmjs.org/chainsaw/0.1.0)、[全部版本/时间](https://registry.npmjs.org/chainsaw)、[发布包](https://registry.npmjs.org/chainsaw/-/chainsaw-0.1.0.tgz)。本地 `chainsaw-version.json`、`chainsaw-registry.json`、`chainsaw-published-tarball.tgz`、`published/chainsaw/`。
- **[S04]** [https 1.0.0官方元数据](https://registry.npmjs.org/https/1.0.0)、[全部版本/时间](https://registry.npmjs.org/https)、[发布包](https://registry.npmjs.org/https/-/https-1.0.0.tgz)。本地 `https-version.json`、`https-registry.json`、`https-published-tarball.tgz`、`published/https/package.json`。
- **[G01]** [binary官方指定仓库API](https://api.github.com/repos/substack/node-binary)、[tags](https://api.github.com/repos/substack/node-binary/tags)、[LICENSE](https://raw.githubusercontent.com/substack/node-binary/master/LICENSE)。本地 `binary-repository.json`、`binary-tags.json`、`binary-master-license.txt`。
- **[G02]** [buffers官方指定仓库API](https://api.github.com/repos/substack/node-buffers)、[tags](https://api.github.com/repos/substack/node-buffers/tags)、[LICENSE](https://raw.githubusercontent.com/substack/node-buffers/master/LICENSE)。本地对应 `buffers-*`。
- **[G03]** [chainsaw官方指定仓库API](https://api.github.com/repos/substack/node-chainsaw)、[tags](https://api.github.com/repos/substack/node-chainsaw/tags)、[LICENSE](https://raw.githubusercontent.com/substack/node-chainsaw/master/LICENSE)。本地对应 `chainsaw-*`。
- **[G04]** [API控制请求](https://api.github.com/repos/exceljs/exceljs)。本地 `github-availability-control.json`。
- **[A01]** [unzipper 0.12.5版本元数据](https://registry.npmjs.org/unzipper/0.12.5)、[确切发布包](https://registry.npmjs.org/unzipper/-/unzipper-0.12.5.tgz)、[gitHead提交](https://api.github.com/repos/ZJONSSON/node-unzipper/commits/aaf77f0c7b4d29af500b0aa9c0e2aa2ade0a2618)、[同提交LICENSE](https://raw.githubusercontent.com/ZJONSSON/node-unzipper/aaf77f0c7b4d29af500b0aa9c0e2aa2ade0a2618/LICENSE)。本地 `unzipper-0.12.5-*`、`published/unzipper-0.12.5/`。
- **[A02]** [ExcelJS 4.4.0元数据](https://registry.npmjs.org/exceljs/4.4.0)、[发布包](https://registry.npmjs.org/exceljs/-/exceljs-4.4.0.tgz)、[unzipper 0.10.14元数据](https://registry.npmjs.org/unzipper/0.10.14)。本地 `exceljs-version.json`、`exceljs-4.4.0-published-tarball.tgz`、`unzipper-version.json`、`published/exceljs-4.4.0/lib/stream/xlsx/workbook-reader.js`。
- **[A03]** [PptxGenJS 4.0.1元数据](https://registry.npmjs.org/pptxgenjs/4.0.1)、[发布包](https://registry.npmjs.org/pptxgenjs/-/pptxgenjs-4.0.1.tgz)。本地 `pptxgenjs-version.json`、`pptxgenjs-4.0.1-published-tarball.tgz`、`published/pptxgenjs-4.0.1/dist/pptxgen.cjs.js`。
- **[A04]** [unzipper 0.12.3官方元数据](https://registry.npmjs.org/unzipper/0.12.3)、[发布包](https://registry.npmjs.org/unzipper/-/unzipper-0.12.3.tgz)、[gitHead提交](https://api.github.com/repos/ZJONSSON/node-unzipper/commits/d19c3fb9c1bbdce6e6bcb701ac65ddb071e1eb31)、[确切提交LICENSE](https://raw.githubusercontent.com/ZJONSSON/node-unzipper/d19c3fb9c1bbdce6e6bcb701ac65ddb071e1eb31/LICENSE)。本地 `unzipper-0.12.3-*`、`published/unzipper-0.12.3/`。
- **[A05]** [unzipper 0.12.4官方元数据](https://registry.npmjs.org/unzipper/0.12.4)、[发布包](https://registry.npmjs.org/unzipper/-/unzipper-0.12.4.tgz)、[gitHead提交](https://api.github.com/repos/ZJONSSON/node-unzipper/commits/b8906c8c210ecce08962d3732ea32fd7e3072fe2)、[确切提交LICENSE](https://raw.githubusercontent.com/ZJONSSON/node-unzipper/b8906c8c210ecce08962d3732ea32fd7e3072fe2/LICENSE)。本地 `unzipper-0.12.4-*`、`published/unzipper-0.12.4/`。
- **[N01]** [Node v24.14.0 CommonJS：内建模块及node:前缀](https://nodejs.org/download/release/v24.14.0/docs/api/modules.html#built-in-modules)。本地 `node-commonjs.txt`。
- **[N02]** [Node v24.14.0 HTTPS文档](https://nodejs.org/download/release/v24.14.0/docs/api/https.html)。本地 `node-https.txt`。
- **[E01]** [package-inspection.json](../../output/license-research15/package-inspection.json)：原四项tar成员、与安装文件的逐文件哈希、发布日、运行时探测。
- **[E02]** [dependency-resolution.json](../../output/license-research15/dependency-resolution.json)：当时锁文件SHA256 `c161c47ea1888e409e3a92dec9aaed19c0b46c347eecc0685f1ff8421064f6e6` 及相关确切路径/依赖快照。
- **[E03]** [作者网站响应](../../output/license-research15/substack-author-site.txt)、[https作者旧域名响应](../../output/license-research15/https-author-site.txt)：最终跳转信息在capture-manifest.json。
- **[E04]** [alternative-inspection.json](../../output/license-research15/alternative-inspection.json)、[verification.json](../../output/license-research15/verification.json)：替换方案发布包校验、所需API行号、原四项校验及根unzipper闭包。
- **[E05]** [older-bundle-probe.json](../../output/license-research15/older-bundle-probe.json)、[0.12.5实际回归日志原样副本](../../output/license-research15/unzipper-0.12.5-regression-failure.log)：后续失败及0.12.3/0.12.4隔离构建探测。原日志 `output/15-license-reconciled-check.log` 保持未修改。
- **[E06]** [older-alternative-inspection.json](../../output/license-research15/older-alternative-inspection.json)：0.12.3/0.12.4完整tar成员哈希、许可证绑定、全部字面量依赖加载清单。
- **[E07]** [followup-verification.json](../../output/license-research15/followup-verification.json)：追加后的HTTP响应哈希核验。

原四项的许可原文补齐仍然未闭合；后续移除或替换的决策、实现、回归及交付身份变化须另行记录，本文件只提供可复核事实。
