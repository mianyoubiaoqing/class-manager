import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  mkdir,
  stat,
  open,
  link,
  rename,
  unlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { officeTargetStamp, saveOfficeFile } from '../src/main/office-files';

async function fixture() {
  const parent = resolve('output/office-files-tests');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'run-'));
}

test('new file publication is exclusive and a stale overwrite stamp preserves a concurrent edit', async () => {
  const root = await fixture();
  const path = join(root, 'lesson.docx');
  await saveOfficeFile(path, Buffer.from('new'), 'docx', null);
  expect(await readFile(path, 'utf8')).toBe('new');
  await expect(saveOfficeFile(path, Buffer.from('replace'), 'docx', null)).rejects.toMatchObject({
    code: 'EXPORT_CONFLICT',
  });
  const stamp = await officeTargetStamp(path);
  await writeFile(path, 'concurrent teacher edit');
  await expect(saveOfficeFile(path, Buffer.from('replace'), 'docx', stamp)).rejects.toMatchObject({
    code: 'EXPORT_CONFLICT',
  });
  expect(await readFile(path, 'utf8')).toBe('concurrent teacher edit');
  expect(await readdir(root)).toEqual(['lesson.docx']);
});

test('confirmed matching overwrite atomically replaces the target without leaving temporary files', async () => {
  const root = await fixture();
  const path = join(root, 'lesson.pptx');
  await writeFile(path, 'old');
  await saveOfficeFile(
    path,
    Buffer.from('complete new file'),
    'pptx',
    await officeTargetStamp(path),
  );
  expect(await readFile(path, 'utf8')).toBe('complete new file');
  expect(await readdir(root)).toEqual(['lesson.pptx']);
});

test('cancellation during a large write leaves the previous file intact and cleans its temporary file', async () => {
  const root = await fixture();
  const path = join(root, 'lesson.docx');
  await writeFile(path, 'old');
  const stamp = await officeTargetStamp(path);
  const controller = new AbortController();
  const pending = saveOfficeFile(
    path,
    Buffer.alloc(32 * 1024 * 1024, 65),
    'docx',
    stamp,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: 'EXPORT_CANCELLED' });
  const deadline = Date.now() + 3000;
  let observedPartialWrite = false;
  while (Date.now() < deadline) {
    const temporary = (await readdir(root)).find((name) => name.endsWith('.cmexport-tmp'));
    if (temporary) {
      const size = (await stat(join(root, temporary))).size;
      if (size > 0 && size < 32 * 1024 * 1024) {
        observedPartialWrite = true;
        break;
      }
    }
  }
  expect(observedPartialWrite).toBe(true);
  controller.abort();
  await rejected;
  expect(await readFile(path, 'utf8')).toBe('old');
  expect(await readdir(root)).toEqual(['lesson.docx']);
});

test('bad extensions, directory targets and unavailable destinations never replace existing content', async () => {
  const root = await fixture();
  const path = join(root, 'existing.txt');
  await writeFile(path, 'old');
  await expect(saveOfficeFile(path, Buffer.from('new'), 'docx', null)).rejects.toMatchObject({
    code: 'EXPORT_DESTINATION',
  });
  await expect(officeTargetStamp(root)).rejects.toMatchObject({ code: 'EXPORT_DESTINATION' });
  await expect(
    saveOfficeFile(join(root, 'missing', 'lesson.docx'), Buffer.from('new'), 'docx', null),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path, 'utf8')).toBe('old');
  expect(await readdir(root)).toEqual(['existing.txt']);
});

test.each(['sync', 'rename', 'permission'] as const)(
  'filesystem %s failure preserves the previous target and cleans its own temporary file',
  async (mode) => {
    const root = await fixture();
    const path = join(root, 'lesson.docx');
    await writeFile(path, 'old');
    const stamp = await officeTargetStamp(path);
    const failure = () =>
      Object.assign(new Error('Synthetic filesystem failure'), {
        code: mode === 'permission' ? 'EACCES' : 'EIO',
      });
    const operations = { open, link, rename, unlink };
    if (mode === 'rename')
      operations.rename = async () => {
        throw failure();
      };
    else
      operations.open = async (...args) => {
        if (mode === 'permission') throw failure();
        const handle = await open(...args);
        handle.sync = async () => {
          throw failure();
        };
        return handle;
      };
    await expect(
      saveOfficeFile(path, Buffer.from('new'), 'docx', stamp, undefined, operations),
    ).rejects.toMatchObject({ code: mode === 'permission' ? 'EACCES' : 'EIO' });
    expect(await readFile(path, 'utf8')).toBe('old');
    expect(await readdir(root)).toEqual(['lesson.docx']);
  },
);
