# 15 最终候选取消场景排查

2026-10-02。当前构建与17候选的82个运行文件、19个dist/ASAR内容一致；15另含NSIS辅助程序。全部操作为隔离合成资料，传输为确定性替身。

备课及成长档案整页脚本在取消场景首次超时：前者仅等待alert中“取消”，后者在“已请求取消”后等待ABORTED稳定提示。运行时没有未处理异常，但超时不能算通过。

诊断采用diagnosing-bugs流程。反馈命令为`rtk node output/run-15-ui.cjs lesson-c-drive scripts/lesson-ui-smoke.mjs`和growth对应命令，失败日志保留。最小区分点是取消/生成IPC回执与界面提示，不重复推测整个业务模块。假设依次为提示被后到回执覆盖、迟到释放早于Main取消完成、产品取消遗漏导致保存。

在测试Main包裹真实具名处理器，只收集方法名、ok和错误code，不记录入参/正文。观测结果两场景均为`generate… ok:false code:ABORTED`先于`cancel… ok:true`，最终可见状态为“正在取消…”或“已请求取消…”。因此原断言依赖了一种特定回包顺序。备课脚本还增加Main取消成功屏障后才释放迟到传输，并等待生成按钮消失；成长脚本直接核验真实ABORTED生成回执及总结数量不增。原教师修订标题、冻结版及重开内容均保留。

修正后的完整备课与成长界面流程通过，产品src未修改，没有新增付费请求。测试中的回执探针作为取消边界回归保留，用于核验实际处理器结果，临时日志只输出结构化取消code及合成界面提示。备课探针首轮误用不存在的message选择器所致失败也保留，已改为实际notice容器并复跑。

证据：`output/15-ui-lesson-c-drive.log`、`15-ui-growth-c-drive.log`、`15-ui-lesson-cancel-probe.log`为失败；`15-ui-lesson-cancel-confirmed.log`、`15-ui-growth-cancel-probe.log`为最终通过。最终交付的证据归档会逐项核验原始/归档身份。
