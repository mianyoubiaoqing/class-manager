import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { createResourcePrintDocument } from '../src/core/resource-print';
const roots: string[] = [];
const workspaces: Workspace[] = [];
test('resource print escapes supplied markup and paginates long Unicode content', () => {
  const document = createResourcePrintDocument({
    epoch: randomUUID(),
    key: 'sx:rja:b0:u0:l0:s0',
    type: 'design',
    body: '<script>alert(1)</script>\n' + '集合😀'.repeat(600),
  });
  expect(document.html).not.toContain('<script>');
  expect(document.html).toContain('&lt;script&gt;');
  expect(document.pageCount).toBeGreaterThan(1);
  expect(document.html.match(/class="page"/g)).toHaveLength(document.pageCount);
  expect(document.html).not.toContain('�');
});
afterEach(() => {
  workspaces.splice(0).forEach((w) => w.close());
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
});
test('a subject resource saves without a class and survives restart and backup restore', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-resource-'));
  roots.push(root);
  let w = new Workspace(root);
  workspaces.push(w);
  const input = {
    epoch: w.snapshot().epoch,
    key: 'sx:rja:b0:u0:l0:s0',
    type: 'design',
    expectedRevision: 0,
    requestId: randomUUID(),
    body: '数学教案\n先观察集合实例，再用集合语言表示。',
  };
  const record = w.resources.save(input);
  expect(w.resources.save(input)).toEqual(record);
  expect(w.snapshot().classes).toEqual([]);
  const backup = w.exportBackup({ epoch: input.epoch });
  w.resources.save({
    ...input,
    expectedRevision: 1,
    requestId: randomUUID(),
    body: '后来更正的内容',
  });
  const preview = w.previewRestore(backup);
  const restored = w.commitRestore({ epoch: input.epoch, token: preview.token });
  expect(
    w.resources.read({ epoch: restored.epoch, key: input.key, type: input.type }),
  ).toMatchObject({ body: input.body });
  w.close();
  workspaces.splice(workspaces.indexOf(w), 1);
  w = new Workspace(root);
  workspaces.push(w);
  expect(
    w.resources.read({ epoch: w.snapshot().epoch, key: input.key, type: input.type }),
  ).toMatchObject({ body: input.body, revision: 1 });
  expect(() =>
    w.resources.save({ ...input, epoch: w.snapshot().epoch, requestId: randomUUID() }),
  ).toThrow(/版本|修改/);
});
test('local files and HTTPS references bind to a chapter, survive backup and reject other chapter access', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-resource-files-'));
  roots.push(root);
  const w = new Workspace(root);
  workspaces.push(w);
  const input = { epoch: w.snapshot().epoch, key: 'sx:rja:b0:u0:l0:s0', type: 'design' };
  const file = w.resources.storeFile({
    ...input,
    name: '课堂资料.txt',
    bytes: Buffer.from('集合的实际例子'),
  });
  const link = w.resources.addLink({ ...input, name: '参考资料', url: 'https://www.zxx.edu.cn/' });
  expect(
    w.resources.storeFile({ ...input, name: '课堂资料.txt', bytes: Buffer.from('集合的实际例子') }),
  ).toEqual(file);
  expect(() =>
    w.resources.readFile({ ...input, key: 'sx:rja:b0:u0:l0:s1', id: file.id }),
  ).toThrow();
  expect(() =>
    w.resources.storeFile({ ...input, name: '脚本.js', bytes: Buffer.from('bad') }),
  ).toThrow();
  const preview = w.previewRestore(w.exportBackup({ epoch: input.epoch }));
  const current = w.commitRestore({ epoch: input.epoch, token: preview.token });
  const restored = { ...input, epoch: current.epoch };
  expect(w.resources.listFiles(restored)).toHaveLength(2);
  expect(Buffer.from(w.resources.readFile({ ...restored, id: file.id }).bytes!).toString()).toBe(
    '集合的实际例子',
  );
  expect(w.resources.readFile({ ...restored, id: link.id }).url).toBe(link.url);
  w.resources.removeFile({ ...restored, id: file.id });
  expect(w.resources.listFiles(restored)).toHaveLength(1);
});
