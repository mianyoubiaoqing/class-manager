import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../../src/core/workspace';
import { MaterialTaskRunner } from '../../src/main/material-task';
import { lessonFixture, lessonProvider } from './lesson-storage';
import { syntheticPdf } from './material-pdf';

async function main() {
  const directory = resolve('output/lesson-runtime');
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'workspace-'));
  const parserPath = resolve('dist/main/material-process.cjs');
  const runner = new MaterialTaskRunner(parserPath);
  let workspace = new Workspace(root);
  try {
    const epoch = workspace.snapshot().epoch;
    const parsed = await runner.parse(Buffer.from('力有大小、方向和作用点。'), 'txt');
    workspace.materials.store({ epoch, requestId: randomUUID(), name: '合成教材.txt', parsed });
    const pdf = await runner.parse(syntheticPdf([{ text: 'Synthetic storage page' }]), 'pdf');
    workspace.materials.store({ epoch, requestId: randomUUID(), name: '合成页.pdf', parsed: pdf });
    const { request, content } = lessonFixture(parsed.version.id);
    const prepared = workspace.lessons.prepare({ epoch, request });
    const command = {
      epoch,
      token: prepared.token,
      requestId: randomUUID(),
      provider: lessonProvider,
      output: JSON.stringify(content),
    };
    workspace.lessons.claim({ epoch, token: command.token, requestId: command.requestId });
    const draft = workspace.lessons.complete(command);
    workspace.lessons.edit({
      epoch,
      id: draft.id,
      expectedRevision: 1,
      content: { ...content, title: '教师复核冻结初版' },
    });
    const first = workspace.lessons.freeze({
      epoch,
      id: draft.id,
      expectedRevision: 2,
      requestId: randomUUID(),
      reason: '运行时合成确认',
    });
    const saved = workspace.lessons.readVersion({ epoch, versionId: first.versionId });
    const revision = workspace.lessons.revise({
      epoch,
      versionId: first.versionId,
      requestId: randomUUID(),
    });
    workspace.lessons.edit({
      epoch,
      id: revision.id,
      expectedRevision: 1,
      content: { ...content, title: '运行时修订第二版' },
    });
    const second = workspace.lessons.freeze({
      epoch,
      id: revision.id,
      expectedRevision: 2,
      requestId: randomUUID(),
      reason: '运行时第二版',
    });
    assert.equal(second.revision, 2);
    workspace.close();
    workspace = new Workspace(root);
    assert.deepEqual(workspace.lessons.readVersion({ epoch, versionId: first.versionId }), saved);
    const preview = workspace.previewRestore(workspace.exportBackup({ epoch }));
    assert.equal(preview.materialVersionCount, 2);
    assert.equal(preview.lessonDraftCount, 2);
    assert.equal(preview.lessonVersionCount, 2);
    const restored = workspace.commitRestore({ epoch, token: preview.token });
    assert.deepEqual(
      workspace.lessons.readVersion({ epoch: restored.epoch, versionId: first.versionId }),
      saved,
    );
    assert.deepEqual(
      workspace.materials.readAsset({
        epoch: restored.epoch,
        id: pdf.version.id,
        assetId: pdf.version.originalAssetId,
      }).bytes,
      pdf.assets[0]!.bytes,
    );
    console.log(
      JSON.stringify({
        status: 'passed',
        root,
        parserPath,
        versions: process.versions,
        synthetic: true,
        networkCalls: 0,
        cases: [
          'isolated-import-persistence',
          'teacher-edit-freeze',
          'local-revision',
          'reopen-immutable-version',
          'v6-backup-restore',
          'pdf-original-identity',
        ],
      }),
    );
  } finally {
    workspace.close();
    await runner.close();
  }
}
void main().catch(() => {
  console.error('Lesson storage runtime verification failed');
  process.exitCode = 1;
});
