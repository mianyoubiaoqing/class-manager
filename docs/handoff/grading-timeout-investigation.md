# 11 单次真实图像请求超时证据

以下为首次请求的 2026-10-01 历史调查。2026-10-02 用户追加一次明确授权，相同两页六题请求成功，普通题型识别与评分金标准比较通过，3059 Token、零重试，见 [真实图像验收](grading-live-acceptance.md)。原失败报告及锁保持不变，首次超时根因仍未知。

实际请求于 2026-10-01 19:32:59.634 UTC 认领，应用账本持续 60043 ms 后记录 TIMEOUT。guard 确认调用原始 fetch 一次；没有正常模型结果、responseId 或 provider usage。原报告及单次锁不变，禁止据旧授权重发。

已核对当前生产代码：图像走 `deepseek-flash`、Chat Completions 用户消息的内联 JPEG data URL、JSON 输出，thinking disabled，max_tokens 16384；生成请求的自动重试次数为 0，应用总期限为 60 秒。两次同脚本无网络预演验证了完整协议、图像字节、选题、UI 修订与人工金标准比较；生产候选 EXE/ASAR 哈希正确。预演只证明本地路径，不证明网络或服务端正确。

只读查阅官方资料：

- [Vision](https://api-docs.deepseek.com/guides/vision/) 明确 `deepseek-flash` 支持 Chat Completions `image_url` 内联 JPEG data URL，未发现本次消息格式与文档要求冲突。
- [Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit/) 说明请求可能等待，非流式期间可能返回空行；若十分钟尚未开始推理，服务端才关闭连接。这并不保证客户端的 60 秒期限内得到结果，也不能证明本次实际处于排队状态。

当时只能确认“首次外部生成未在本应用 deadline 内完成”。网络连接、服务端等待或生成耗时尚未区分；没有响应时间段或服务端诊断信息，不推断根因。失败后离线重开检查已通过，六题输入和 TIMEOUT 尝试保存，未产生复核或入分。该阶段未改生产期限，也未调用第二次；后续追加授权成功不修改这些失败事实。

该阶段诊断遵循 diagnosing-bugs 的反馈循环；首次单次授权已消耗，没有为复现反复调用付费服务。后续新授权请求保持相同生产期限和完整样本，结果成功但不能证明外部超时根因已修复。两次单次授权均已使用；任何后续付费请求仍须新的明确授权，保留既有报告和锁，新增尝试单独持久记录。
