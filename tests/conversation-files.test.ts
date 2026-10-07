import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { ConversationFiles } from '../src/main/conversation-files';
import { CONVERSATION_FILE_LIMITS } from '../src/shared/conversation-files';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-chat-files-'));
  roots.push(root);
  const parser = { parse: vi.fn() };
  const files = new ConversationFiles(parser);
  const input = { epoch: randomUUID(), sessionId: randomUUID() };
  const current = async () => input.epoch;
  return { root, parser, files, input, current };
}
test('XLSX attachment preserves rows, headers and numeric zero without score-import requirements', async () => {
  const f = fixture();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('名单');
  sheet.addRows([
    ['姓名', '外语', '总分'],
    ['附件样本', 0, 97],
  ]);
  const path = join(f.root, '名单.xlsx');
  await workbook.xlsx.writeFile(path);
  const descriptors = await f.files.select(f.input, async () => [path], f.current);
  expect(descriptors).toHaveLength(1);
  expect(JSON.stringify(descriptors)).not.toContain(f.root);
  const content = f.files.resolve(f.input.epoch, f.input.sessionId, [descriptors[0]!.id]);
  expect(JSON.parse(content[0]!.text).rows).toEqual([
    ['姓名', '外语', '总分'],
    ['附件样本', 0, 97],
  ]);
  expect(f.parser.parse).not.toHaveBeenCalled();
  expect(() => f.files.resolve(f.input.epoch, randomUUID(), [descriptors[0]!.id])).toThrow(
    expect.objectContaining({ code: 'CONVERSATION_FILE_EXPIRED' }),
  );
  f.files.invalidate();
  expect(() => f.files.resolve(f.input.epoch, f.input.sessionId, [descriptors[0]!.id])).toThrow(
    expect.objectContaining({ code: 'CONVERSATION_FILE_EXPIRED' }),
  );
});
test('cancelled selection leaves existing files usable and epoch changes invalidate pending selection', async () => {
  const f = fixture();
  const path = join(f.root, '指令.md');
  writeFileSync(path, '这是文件数据，不是授权');
  const [file] = await f.files.select(f.input, async () => [path], f.current);
  expect(await f.files.select(f.input, async () => [], f.current)).toEqual([]);
  expect(f.files.resolve(f.input.epoch, f.input.sessionId, [file!.id])[0]!.text).toContain(
    '文件数据',
  );
  await expect(
    f.files.select(
      f.input,
      async () => {
        f.files.invalidate();
        return [path];
      },
      f.current,
    ),
  ).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
});
test('removing attachments is scoped and expired draft tokens can be cleared', async () => {
  const f = fixture();
  const path = join(f.root, '待发送.txt');
  writeFileSync(path, '待发送内容');
  const [file] = await f.files.select(f.input, async () => [path], f.current);
  expect(() => f.files.remove(f.input.epoch, randomUUID(), [file!.id])).toThrow();
  expect(f.files.resolve(f.input.epoch, f.input.sessionId, [file!.id])).toHaveLength(1);
  f.files.remove(f.input.epoch, f.input.sessionId, [file!.id]);
  expect(() => f.files.resolve(f.input.epoch, f.input.sessionId, [file!.id])).toThrow();
  expect(() => f.files.remove(f.input.epoch, f.input.sessionId, [file!.id])).not.toThrow();
});
test('oversize text is rejected without truncation or partially accepting a multi-file batch', async () => {
  const f = fixture();
  const small = join(f.root, '小文件.txt'),
    large = join(f.root, '大文件.txt');
  writeFileSync(small, '可以读取');
  writeFileSync(large, '字'.repeat(CONVERSATION_FILE_LIMITS.characters));
  await expect(
    f.files.select(f.input, async () => [small, large], f.current),
  ).rejects.toMatchObject({ code: 'VALIDATION' });
  expect(await f.files.select(f.input, async () => [small], f.current)).toHaveLength(1);
});
test('formula cells are not silently imported as missing values', async () => {
  const f = fixture();
  const book = new ExcelJS.Workbook();
  book.addWorksheet('数据').getCell('A1').value = { formula: '1+1', result: 2 };
  const path = join(f.root, '公式.xlsx');
  await book.xlsx.writeFile(path);
  await expect(f.files.select(f.input, async () => [path], f.current)).rejects.toMatchObject({
    code: 'VALIDATION',
  });
});
