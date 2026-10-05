import { LESSON_LIMITS, type MaterialFragment } from '../shared/lessons';
import { DomainError } from './errors';

/**
 * Parse bounded UTF-8 (optional BOM) into literal, line-addressable fragments. No HTML/commands
 * are executed. Oversized lines/content and invalid encoding reject without returning a prefix.
 * Pure and deterministic; no filesystem, network or persistence. Failures are MATERIAL_INVALID.
 */
export function parseTextMaterial(bytes: Uint8Array): MaterialFragment[] {
  const invalid = (message: string): never => {
    throw new DomainError('MATERIAL_INVALID', message);
  };
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.byteLength ||
    bytes.byteLength > LESSON_LIMITS.fileBytes
  )
    invalid('资料为空或超过 10 MiB。');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid('文本资料必须为有效 UTF-8 编码。');
  }
  // Newlines and tabs are literal content; other ASCII controls indicate a non-text file.
  // eslint-disable-next-line no-control-regex -- Reject binary content while preserving text whitespace.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    invalid('文本资料含不支持的控制字符。');
  if (text.length > LESSON_LIMITS.sourceCharacters) invalid('文字超过 200000 字符，请分拆资料。');
  if (!text.trim()) invalid('文本资料没有可读内容。');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const fragments: MaterialFragment[] = [];
  let current: string[] = [];
  let length = 0;
  let first = 1;
  function flush(last: number) {
    const body = current.join('\n');
    if (body.trim())
      fragments.push({
        id: fragments.length + 1,
        kind: 'text',
        locator: { kind: 'lines', first, last },
        text: body,
      });
    if (fragments.length > LESSON_LIMITS.sourceFragments) invalid('资料片段数量超过限制。');
    current = [];
    length = 0;
    first = last + 1;
  }
  for (const [index, line] of lines.entries()) {
    if (line.length > LESSON_LIMITS.fragmentCharacters) invalid('单行超过 8000 字符，请先分段。');
    if (length + (current.length ? 1 : 0) + line.length > LESSON_LIMITS.fragmentCharacters)
      flush(index);
    length += (current.length ? 1 : 0) + line.length;
    current.push(line);
  }
  flush(lines.length);
  return fragments;
}
