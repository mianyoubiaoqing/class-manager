// 仅记录真实 Main 处理器的回执状态；不更改处理结果、不保存请求或返回的业务数据。
// 输入为本轮应用、独立记录键和已注册方法；每轮只装一次，缺少处理器或调用失败直接抛错。
export async function recordAuditIpcResults(application, key, methods) {
  await application.evaluate(
    ({ ipcMain }, { key, methods }) => {
      globalThis[key] = [];
      for (const method of methods) {
        const name = `cm:${method}`;
        const handler = ipcMain._invokeHandlers.get(name);
        if (!handler) throw Error(`Missing actual IPC handler: ${method}`);
        ipcMain._invokeHandlers.set(name, async (...args) => {
          const result = await handler(...args);
          globalThis[key].push({ method, ok: result.ok, code: result.error?.code });
          return result;
        });
      }
    },
    { key, methods },
  );
}
