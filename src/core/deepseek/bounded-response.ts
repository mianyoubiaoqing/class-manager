import { DomainError } from '../errors';

/** 即使传输忽略AbortSignal也结束本地等待；不采用迟到结果，不表示服务商已停止计费。 */
export async function awaitModelResponse<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let cancel!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(new DomainError('ABORTED', '模型任务已取消。'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** Bound decoded response bytes before JSON parsing; this also bounds a compressed HTTP response. */
export async function readBoundedResponse(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<string> {
  const abort = () => {
    if (signal?.aborted) throw new DomainError('ABORTED', 'DeepSeek 任务已取消。');
  };
  abort();
  const declared = response.headers?.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
    void response.body?.cancel().catch(() => {});
    throw new DomainError('RESPONSE_LIMIT', '模型响应超过大小上限。');
  }
  // Compatibility with deterministic test transports; native Fetch responses use the stream path.
  if (!response.body) {
    let text: string;
    try {
      text =
        typeof response.text === 'function'
          ? await awaitModelResponse(response.text(), signal)
          : JSON.stringify(await awaitModelResponse(response.json(), signal));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new DomainError('INVALID_RESPONSE', '模型返回的内容不是有效JSON。');
      throw error;
    }
    abort();
    if (Buffer.byteLength(text) > maximum)
      throw new DomainError('RESPONSE_LIMIT', '模型响应超过大小上限。');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      abort();
      const { done, value } = await awaitModelResponse(reader.read(), signal);
      abort();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        cancel();
        throw new DomainError('RESPONSE_LIMIT', '模型响应超过大小上限。');
      }
      chunks.push(value);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new DomainError('INVALID_RESPONSE', '模型响应不是有效 UTF-8。');
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
