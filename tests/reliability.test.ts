import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { DomainError, publicError } from '../src/core/errors';
import { assertExportDestination, isTrustedSender } from '../src/main/security';
import { WorkerClient } from '../src/main/worker-client';

const roots: string[] = [];
const live: Workspace[] = [];
function create() {
  const root = mkdtempSync(join(tmpdir(), 'cm-reliability-'));
  roots.push(root);
  const workspace = new Workspace(root);
  live.push(workspace);
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '合成一班' });
  workspace.createClass({ epoch, name: '合成二班' });
  const classId = workspace.snapshot().classes[0]!.id;
  workspace.saveStudent({ epoch, classId, studentNumber: 'DEMO-01', displayName: '合成同名' });
  return { workspace, epoch, root, classId };
}
function close(workspace: Workspace) {
  workspace.close();
  live.splice(live.indexOf(workspace), 1);
}
afterEach(() => {
  vi.useRealTimers();
  for (const workspace of live.splice(0)) workspace.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('moving the system clock backwards cannot create invalid enrollment intervals', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
  const { workspace, epoch } = create();
  const student = workspace.snapshot().students[0]!;
  vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  workspace.setStudentActive({
    epoch,
    id: student.id,
    expectedRevision: student.revision,
    active: false,
  });
  const entry = workspace.snapshot().enrollments[0]!;
  expect(entry.validTo! >= entry.validFrom).toBe(true);
});

test('user can preview and restore the complete automatic recovery copy', () => {
  const { workspace, epoch } = create();
  const backup = workspace.exportBackup({ epoch });
  workspace.createClass({ epoch, name: '合成恢复前保留' });
  const preview = workspace.previewRestore(backup);
  workspace.commitRestore({ epoch, token: preview.token });
  const afterRestore = workspace.snapshot();
  expect(afterRestore.classes).toHaveLength(2);
  const recovery = workspace.previewRecovery();
  expect(recovery.classCount).toBe(3);
  workspace.commitRestore({ epoch: afterRestore.epoch, token: recovery.token });
  expect(workspace.snapshot().classes).toHaveLength(3);
});

test('duplicate names remain different students but case-folded student numbers cannot collide', () => {
  const { workspace, epoch, classId } = create();
  workspace.saveStudent({ epoch, classId, studentNumber: 'DEMO-02', displayName: '合成同名' });
  expect(workspace.snapshot().students).toHaveLength(2);
  expect(new Set(workspace.snapshot().students.map((student) => student.id)).size).toBe(2);
  expect(() =>
    workspace.saveStudent({ epoch, classId, studentNumber: 'demo-01', displayName: '不应写入' }),
  ).toThrow('编号已存在');
});

test('transfer keeps the student identity and closes rather than rewrites the old enrollment', () => {
  const { workspace, epoch } = create();
  const before = workspace.snapshot();
  const student = before.students[0]!;
  const target = before.classes.find((classroom) => classroom.id !== student.classId)!;
  workspace.saveStudent({
    epoch,
    id: student.id,
    expectedRevision: student.revision,
    studentNumber: student.studentNumber,
    displayName: '合成改名',
    classId: target.id,
  });
  const after = workspace.snapshot();
  expect(after.students[0]?.id).toBe(student.id);
  expect(after.enrollments).toHaveLength(2);
  expect(after.enrollments[0]?.classId).toBe(before.enrollments[0]?.classId);
  expect(after.enrollments[0]?.validTo).not.toBeNull();
  expect(after.enrollments[1]?.validTo).toBeNull();
});

test('stale edits are rejected without overwriting a newer saved value', () => {
  const { workspace, epoch, classId } = create();
  const student = workspace.snapshot().students[0]!;
  const input = {
    epoch,
    classId,
    id: student.id,
    expectedRevision: student.revision,
    studentNumber: student.studentNumber,
    displayName: '合成新版',
  };
  workspace.saveStudent(input);
  expect(() => workspace.saveStudent({ ...input, displayName: '陈旧写入' })).toThrow('已被修改');
  expect(workspace.snapshot().students[0]?.displayName).toBe('合成新版');
});

test('deactivation and reactivation preserve enrollment history', () => {
  const { workspace, epoch } = create();
  const student = workspace.snapshot().students[0]!;
  workspace.setStudentActive({
    epoch,
    id: student.id,
    expectedRevision: student.revision,
    active: false,
  });
  expect(workspace.snapshot().students[0]?.active).toBe(false);
  expect(workspace.snapshot().enrollments[0]?.validTo).not.toBeNull();
  workspace.setStudentActive({
    epoch,
    id: student.id,
    expectedRevision: student.revision + 1,
    active: true,
  });
  expect(workspace.snapshot().students[0]?.active).toBe(true);
  expect(workspace.snapshot().enrollments).toHaveLength(2);
});

test.each(['', '   ', 'line\nbreak', 'a'.repeat(81)])(
  'invalid class name is rejected: %j',
  (name) => {
    const { workspace, epoch } = create();
    expect(() => workspace.createClass({ epoch, name })).toThrow();
    expect(workspace.snapshot().classes).toHaveLength(2);
  },
);

test('demo initialization cannot replace existing data', () => {
  const { workspace, epoch } = create();
  expect(() => workspace.seedDemo({ epoch })).toThrow('空名册');
  expect(workspace.snapshot().students).toHaveLength(1);
});

test.each([
  'format',
  'version',
  'asset-path',
  'duplicate-asset',
  'missing-asset',
  'hash',
  'invalid-base64',
  'database-hash',
])('invalid backup %s is rejected before modifying live data', (kind) => {
  const { workspace, epoch } = create();
  workspace.addSyntheticAsset({ epoch });
  const bundle = JSON.parse(workspace.exportBackup({ epoch }).toString('utf8'));
  switch (kind) {
    case 'format':
      bundle.format = 'zip';
      break;
    case 'version':
      bundle.version = 999;
      break;
    case 'asset-path':
      bundle.assets[0].path = '../../outside';
      break;
    case 'duplicate-asset':
      bundle.assets.push(bundle.assets[0]);
      break;
    case 'missing-asset':
      bundle.assets = [];
      break;
    case 'hash':
      bundle.assets[0].sha256 = '0'.repeat(64);
      break;
    case 'invalid-base64':
      bundle.assets[0].base64 += '!';
      break;
    case 'database-hash':
      bundle.database.sha256 = '0'.repeat(64);
      break;
  }
  expect(() => workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow();
  expect(workspace.snapshot().epoch).toBe(epoch);
  expect(workspace.snapshot().students).toHaveLength(1);
});

test('malformed JSON and oversized backups are refused', () => {
  const { workspace } = create();
  expect(() => workspace.previewRestore(Buffer.from('{'))).toThrow('损坏');
  expect(() => workspace.previewRestore(new Uint8Array(32 * 1024 * 1024 + 1))).toThrow('上限');
});

test('backup with an added SQL trigger is rejected even when its hash matches', () => {
  const { workspace, epoch, root } = create();
  const bundle = JSON.parse(workspace.exportBackup({ epoch }).toString('utf8'));
  const alteredPath = join(root, 'altered.sqlite');
  writeFileSync(alteredPath, Buffer.from(bundle.database.base64, 'base64'));
  const altered = new DatabaseSync(alteredPath);
  altered.exec(
    "CREATE TRIGGER changed AFTER INSERT ON students BEGIN UPDATE students SET display_name='changed'; END",
  );
  altered.close();
  const bytes = readFileSync(alteredPath);
  bundle.database = {
    bytes: bytes.length,
    base64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  expect(() => workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow('结构');
  expect(workspace.snapshot().students[0]?.displayName).toBe('合成同名');
});

test('unknown schema version stops startup and preserves the original file byte-for-byte', () => {
  const { workspace, root, epoch } = create();
  close(workspace);
  const path = join(root, 'workspaces', epoch, 'data.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=999');
  db.close();
  const before = readFileSync(path);
  expect(() => new Workspace(root)).toThrow('版本');
  expect(readFileSync(path)).toEqual(before);
});

test('missing live database is not silently recreated', () => {
  const { workspace, root, epoch } = create();
  close(workspace);
  rmSync(join(root, 'workspaces', epoch, 'data.sqlite'));
  expect(() => new Workspace(root)).toThrow();
});

test('missing immutable attachment blocks backup and startup rather than dropping the reference', () => {
  const { workspace, root, epoch } = create();
  workspace.addSyntheticAsset({ epoch });
  const asset = workspace.snapshot().assets[0]!;
  rmSync(join(root, 'workspaces', epoch, 'assets', `${asset.id}.bin`));
  expect(() => workspace.exportBackup({ epoch })).toThrow();
  close(workspace);
  expect(() => new Workspace(root)).toThrow();
});

test('replacing a preview invalidates the previous restore token', () => {
  const { workspace, epoch } = create();
  const backup = workspace.exportBackup({ epoch });
  const first = workspace.previewRestore(backup);
  const second = workspace.previewRestore(backup);
  expect(() => workspace.commitRestore({ epoch, token: first.token })).toThrow('失效');
  expect(workspace.commitRestore({ epoch, token: second.token }).recoveryCopies).toBe(1);
});

test.each(['staged', 'published'])(
  'abrupt process exit at restore checkpoint %s reopens complete data',
  (checkpoint) => {
    const { workspace, root, epoch } = create();
    const backupPath = join(root, 'restore.cmbackup');
    writeFileSync(backupPath, workspace.exportBackup({ epoch }));
    workspace.createClass({ epoch, name: '合成恢复前新增' });
    close(workspace);
    const childPath = join(root, 'crash-child.cjs');
    buildSync({
      entryPoints: ['tests/fixtures/crash-restore.ts'],
      outfile: childPath,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      target: 'node24',
    });
    const child = spawnSync(process.execPath, [childPath, root, backupPath, checkpoint], {
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(77);
    const reopened = new Workspace(root);
    live.push(reopened);
    expect(reopened.snapshot().classes).toHaveLength(checkpoint === 'staged' ? 3 : 2);
    expect(reopened.snapshot().students).toHaveLength(1);
    expect(reopened.snapshot().epoch === epoch).toBe(checkpoint === 'staged');
  },
);

test('privileged operations reject foreign URLs and subframes', () => {
  const url = 'file:///test/renderer/index.html';
  expect(isTrustedSender(url, url, true)).toBe(true);
  expect(isTrustedSender(url, url, false)).toBe(false);
  expect(isTrustedSender('https://example.com', url, true)).toBe(false);
  expect(isTrustedSender(`${url}?foreign`, url, true)).toBe(false);
});

test('exports cannot overwrite the protected active workspace', () => {
  const { root } = create();
  expect(() => assertExportDestination(join(root, 'current.json'), root)).toThrow('之外');
  expect(() => assertExportDestination(root, root)).toThrow('之外');
  expect(() => assertExportDestination(join(tmpdir(), 'safe-report.json'), root)).not.toThrow();
});

test('unexpected exceptions never return student content, key values, or local paths', () => {
  const error = publicError(new Error('C:\\private\\student.sqlite: SECRET_KEY, 姓名信息'));
  expect(JSON.stringify(error)).not.toMatch(/private|SECRET_KEY|姓名信息/);
  expect(publicError(new DomainError('CONFLICT', '请刷新')).code).toBe('CONFLICT');
});

test('unresponsive worker fails within a deadline and rejects subsequent writes until restart', async () => {
  const { root } = create();
  const path = join(root, 'unresponsive.cjs');
  buildSync({
    entryPoints: ['tests/fixtures/unresponsive-worker.ts'],
    outfile: path,
    platform: 'node',
    format: 'cjs',
    bundle: true,
  });
  const client = new WorkerClient(path, root, 300);
  try {
    expect(await client.call('snapshot')).toMatchObject({
      ok: false,
      error: { code: 'WORKER_UNAVAILABLE' },
    });
    expect(await client.call('createClass', {})).toMatchObject({
      ok: false,
      error: { code: 'WORKER_UNAVAILABLE' },
    });
  } finally {
    await client.close();
  }
});
