import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Workspace } from '../src/core/workspace';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('a synthetic classroom and student survive closing and reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'class-manager-test-'));
  roots.push(root);
  const workspace = new Workspace(root);
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '合成高一一班' });
  const classroom = workspace.snapshot().classes[0]!;
  workspace.saveStudent({
    epoch,
    classId: classroom.id,
    studentNumber: 'DEMO-001',
    displayName: '合成学生甲',
  });
  workspace.close();
  const reopened = new Workspace(root);
  try {
    expect(reopened.snapshot().students).toMatchObject([
      { displayName: '合成学生甲', studentNumber: 'DEMO-001', classId: classroom.id, active: true },
    ]);
  } finally {
    reopened.close();
  }
});

test('a verified backup restores the roster and immutable attachment without accepting old edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'class-manager-test-'));
  roots.push(root);
  const workspace = new Workspace(root);
  try {
    const epoch = workspace.snapshot().epoch;
    workspace.seedDemo({ epoch });
    workspace.addSyntheticAsset({ epoch });
    const backup = workspace.exportBackup({ epoch });
    const student = workspace.snapshot().students[0]!;
    workspace.saveStudent({
      id: student.id,
      classId: student.classId,
      studentNumber: student.studentNumber,
      epoch,
      expectedRevision: student.revision,
      displayName: '合成已修改',
    });
    const preview = workspace.previewRestore(backup);
    expect(preview).toMatchObject({ classCount: 2, studentCount: 100, assetCount: 1 });
    const restored = workspace.commitRestore({ epoch, token: preview.token });
    expect(restored.students[0]?.displayName).toBe(student.displayName);
    expect(restored.assets).toHaveLength(1);
    expect(restored.epoch).not.toBe(epoch);
    expect(() => workspace.createClass({ epoch, name: '陈旧操作' })).toThrow('刷新');
  } finally {
    workspace.close();
  }
});
