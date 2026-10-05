import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { Workspace } from '../src/core/workspace';
import { gradingStorageFixture } from './fixtures/grading-storage';
import { growthMessages } from '../src/core/growth-source';
import type { GrowthCheckpoint } from '../src/core/growth-book';

const roots: string[] = [],
  live: Workspace[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const w of live.splice(0)) w.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(checkpoint?: GrowthCheckpoint) {
  const root = mkdtempSync(join(tmpdir(), 'cm-growth-'));
  roots.push(root);
  const workspace = new Workspace(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    checkpoint,
  );
  live.push(workspace);
  const f = await gradingStorageFixture(workspace, {
    initialScore: '0',
    additionalStudentScore: '7',
  });
  const content = {
    date: '2026-10-01',
    kind: 'conversation' as const,
    description: '合成甲：完整谈话仅本地保存，联系号码 13800138000。',
    source: '合成教师课堂观察',
    action: '下周跟进',
    result: '尚未核实',
    followUp: 'planned' as const,
    summaryFact: '按计划完成了一次订正练习，提出具体问题。',
  };
  const eventInput = {
    epoch: f.epoch,
    requestId: randomUUID(),
    studentId: f.request.studentId,
    content,
    reason: '合成事件首次记录',
  };
  const event = workspace.growth.saveEvent(eventInput);
  const selection = {
    studentId: f.request.studentId,
    from: '2026-10-01',
    to: '2026-10-31',
    events: [{ id: event.id, revision: 1 }],
    scores: [{ versionId: f.score.versionId, subjectId: f.request.subjectId }],
  };
  const prepareInput = {
    epoch: f.epoch,
    selection,
    acknowledgeSyntheticOnly: true as const,
    acknowledgeRedacted: true as const,
  };
  const manual = (content = '教师核对合成阶段事实，后续持续观察。', supersedesEntryId?: string) =>
    workspace.growth.createManual({
      ...prepareInput,
      requestId: randomUUID(),
      content,
      ...(supersedesEntryId ? { supersedesEntryId } : {}),
    });
  const reviewed = () => {
    const draft = manual();
    return workspace.growth.editSummary({
      epoch: f.epoch,
      id: draft.id,
      expectedRevision: 1,
      content: '教师复核：本阶段完成订正练习；继续核实后续结果。',
    });
  };
  const confirmation = (id: string, revision: number) => ({
    epoch: f.epoch,
    id,
    expectedRevision: revision,
    reason: '教师核对后入档',
    acknowledgeReviewed: true as const,
    acknowledgeSources: true as const,
  });
  return {
    ...f,
    workspace,
    root,
    eventInput,
    event,
    selection,
    prepareInput,
    manual,
    reviewed,
    confirmation,
  };
}
function reopen(w: Workspace, root: string) {
  w.close();
  live.splice(live.indexOf(w), 1);
  const next = new Workspace(root);
  live.push(next);
  return next;
}

test.each(['summary-written', 'entry-written', 'committed'] as const)(
  'actual process interruption at %s reopens to an unambiguous archive state',
  async (stage) => {
    const f = await fixture(),
      draft = f.reviewed(),
      command = f.confirmation(draft.id, draft.revision),
      input = join(f.root, 'command.json'),
      script = join(f.root, 'crash.cjs');
    writeFileSync(input, JSON.stringify(command));
    f.workspace.close();
    live.splice(live.indexOf(f.workspace), 1);
    buildSync(
      nodeBundleOptions({
        entryPoints: ['tests/fixtures/crash-growth.ts'],
        outfile: script,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['sharp', 'pdfjs-dist', '@napi-rs/canvas'],
      }),
    );
    const child = spawnSync(process.execPath, [script, f.root, input, stage], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    expect(child.status, child.stderr).toBe(83);
    const next = new Workspace(f.root);
    live.push(next);
    const view = next.growth.readSummary({ epoch: f.epoch, id: draft.id });
    expect(view.record.status).toBe(stage === 'committed' ? 'confirmed' : 'draft');
    expect(Boolean(view.entryId)).toBe(stage === 'committed');
    expect(
      next.growth.timeline({ epoch: f.epoch, studentId: f.request.studentId }).entries,
    ).toHaveLength(stage === 'committed' ? 1 : 0);
    if (stage === 'committed')
      expect(next.growth.confirmSummary(command)).toMatchObject({
        entryId: view.entryId,
        replayed: true,
      });
  },
);

test('offline event corrections keep date, follow-up, content and necessary immutable history; requests replay once', async () => {
  const f = await fixture();
  expect(f.workspace.growth.saveEvent(f.eventInput)).toEqual({ ...f.event, replayed: true });
  const changed = f.workspace.growth.saveEvent({
    ...f.eventInput,
    id: f.event.id,
    expectedRevision: 1,
    requestId: randomUUID(),
    reason: '核实后更正',
    content: {
      ...f.eventInput.content,
      date: '2026-10-02',
      result: '已核对完成',
      followUp: 'completed',
    },
  });
  expect(changed.revision).toBe(2);
  const history = f.workspace.growth.eventHistory({ epoch: f.epoch, id: f.event.id });
  expect(history.map((h) => h.record.revision)).toEqual([2, 1]);
  expect(history[1]?.record.content.description).toContain('完整谈话仅本地保存');
  expect(history[0]?.reason).toBe('核实后更正');
  expect(() =>
    f.workspace.growth.saveEvent({
      ...f.eventInput,
      id: f.event.id,
      expectedRevision: 1,
      requestId: randomUUID(),
    }),
  ).toThrow('变化');
  const next = reopen(f.workspace, f.root);
  expect(
    next.growth.timeline({ epoch: f.epoch, studentId: f.request.studentId }).events[0]?.content
      .followUp,
  ).toBe('completed');
});

test('outbound packet contains selected minimum facts and exact score, never full conversations, local identity or IDs', async () => {
  const f = await fixture(),
    prepared = f.workspace.growth.prepare(f.prepareInput);
  const wire = JSON.stringify(growthMessages(prepared.packet));
  for (const secret of [
    '合成甲',
    'SYNTHETIC_1',
    '合成阅卷班',
    f.request.studentId,
    f.score.versionId,
    '13800138000',
    '完整谈话仅本地保存',
    '合成教师课堂观察',
  ])
    expect(wire).not.toContain(secret);
  expect(wire).toContain('实得 0.00');
  expect(wire).toContain('订正练习');
  expect(prepared.packet.source.selection.scores[0]?.versionId).toBe(f.score.versionId);
  prepared.packet.wire.facts[0]!.text = 'Renderer 更改不能修改后台准备';
  const claimed = f.workspace.growth.claim({
    epoch: f.epoch,
    token: prepared.token,
    requestId: randomUUID(),
  });
  expect(claimed.wire.facts[0]?.text).toBe(f.eventInput.content.summaryFact);
  expect(() =>
    f.workspace.growth.claim({ epoch: f.epoch, token: prepared.token, requestId: randomUUID() }),
  ).toThrow('重复');
});

test.each(['none', 'duplicate', 'outside', 'wrong-student', 'identity', 'diagnosis'] as const)(
  'invalid stage source %s cannot generate a summary',
  async (kind) => {
    const f = await fixture(),
      input = structuredClone(f.prepareInput);
    if (kind === 'none') {
      input.selection.events = [];
      input.selection.scores = [];
    } else if (kind === 'duplicate') input.selection.events.push(input.selection.events[0]!);
    else if (kind === 'outside') input.selection.from = '2026-10-02';
    else if (kind === 'wrong-student')
      input.selection.studentId = f.workspace
        .snapshot()
        .students.find((s) => s.id !== f.request.studentId)!.id;
    else {
      const event = f.workspace.growth.saveEvent({
        ...f.eventInput,
        id: f.event.id,
        expectedRevision: 1,
        requestId: randomUUID(),
        content: {
          ...f.eventInput.content,
          summaryFact: kind === 'identity' ? '合成甲完成订正练习。' : '该学生有人格障碍。',
        },
      });
      input.selection.events[0]!.revision = event.revision;
    }
    expect(() => f.workspace.growth.prepare(input)).toThrow();
    expect(
      f.workspace.growth.timeline({ epoch: f.epoch, studentId: f.request.studentId }).summaries,
    ).toHaveLength(0);
  },
);

test('valid synthetic model output stays a draft and only an edited review can create one formal entry', async () => {
  const f = await fixture(),
    prepared = f.workspace.growth.prepare(f.prepareInput),
    requestId = randomUUID();
  const packet = f.workspace.growth.claim({ epoch: f.epoch, token: prepared.token, requestId });
  const provider = {
    provider: 'deepseek' as const,
    requestModel: 'synthetic',
    responseModel: 'synthetic',
    responseId: 'synthetic-summary',
    generatedAt: new Date().toISOString(),
    durationMs: 1,
    usage: null,
  };
  const command = {
    epoch: f.epoch,
    token: prepared.token,
    requestId,
    provider,
    output: JSON.stringify({
      formatVersion: 1,
      factIds: packet.wire.facts.map((f) => f.id),
      suggestions: [{ text: '下次核实订正过程。', evidenceIds: ['F001'] }],
      limitations: ['事实较少，不能推断人格或心理情况。'],
    }),
  };
  const draft = f.workspace.growth.complete(command);
  expect(f.workspace.growth.complete(command)).toEqual({ ...draft, replayed: true });
  expect(
    f.workspace.growth.timeline({ epoch: f.epoch, studentId: f.request.studentId }).entries,
  ).toHaveLength(0);
  expect(() => f.workspace.growth.confirmSummary(f.confirmation(draft.id, 1))).toThrow('复核');
  const view = f.workspace.growth.readSummary({ epoch: f.epoch, id: draft.id });
  expect(view.record.content).toContain('待教师核实的行动建议');
  const edited = f.workspace.growth.editSummary({
    epoch: f.epoch,
    id: draft.id,
    expectedRevision: 1,
    content: view.record.content,
  });
  const result = f.workspace.growth.confirmSummary(f.confirmation(draft.id, edited.revision));
  expect(f.workspace.growth.confirmSummary(f.confirmation(draft.id, edited.revision))).toEqual({
    ...result,
    replayed: true,
  });
  const next = reopen(f.workspace, f.root);
  expect(
    next.growth.timeline({ epoch: f.epoch, studentId: f.request.studentId }).entries,
  ).toHaveLength(1);
  expect(next.growth.summaryHistory({ epoch: f.epoch, id: draft.id }).map((s) => s.status)).toEqual(
    ['confirmed', 'draft', 'draft'],
  );
});

test('invalid model references or diagnosis are rejected while local events remain editable after cancellation', async () => {
  const f = await fixture(),
    p = f.workspace.growth.prepare(f.prepareInput),
    requestId = randomUUID();
  f.workspace.growth.claim({ epoch: f.epoch, token: p.token, requestId });
  const command = {
    epoch: f.epoch,
    token: p.token,
    requestId,
    provider: {
      provider: 'deepseek',
      requestModel: 'synthetic',
      responseModel: 'synthetic',
      responseId: 'synthetic',
      generatedAt: new Date().toISOString(),
      durationMs: 1,
      usage: null,
    },
    output: JSON.stringify({
      formatVersion: 1,
      factIds: ['F999'],
      suggestions: [],
      limitations: ['资料不足'],
    }),
  };
  expect(() => f.workspace.growth.complete(command)).toThrow('引用');
  f.workspace.growth.cancel({ epoch: f.epoch });
  expect(() => f.workspace.growth.complete(command)).toThrow('失效');
  expect(
    f.workspace.growth.saveEvent({
      ...f.eventInput,
      id: f.event.id,
      expectedRevision: 1,
      requestId: randomUUID(),
      content: { ...f.eventInput.content, result: '离线追加跟进' },
    }).revision,
  ).toBe(2);
});

test.each(['event', 'scores', 'member'] as const)(
  'source change %s blocks confirmation and flags existing formal history without rewriting',
  async (kind) => {
    const f = await fixture(),
      first = f.reviewed();
    const entry = f.workspace.growth.confirmSummary(f.confirmation(first.id, first.revision));
    const pending = f.reviewed();
    if (kind === 'event')
      f.workspace.growth.saveEvent({
        ...f.eventInput,
        id: f.event.id,
        expectedRevision: 1,
        requestId: randomUUID(),
        content: { ...f.eventInput.content, summaryFact: '核实后更正为两次订正练习。' },
      });
    else if (kind === 'member')
      f.workspace.saveStudent({
        epoch: f.epoch,
        id: f.request.studentId,
        expectedRevision: f.workspace.snapshot().students.find((s) => s.id === f.request.studentId)!
          .revision,
        classId: f.scoreInput.classId,
        studentNumber: 'SYNTHETIC_1',
        displayName: '更正合成甲',
      });
    else {
      const edited = f.workspace.grading.edit({
        epoch: f.epoch,
        id: f.draft.id,
        expectedRevision: 1,
        edits: f.edits,
      });
      const review = f.workspace.grading.freeze({
        epoch: f.epoch,
        id: f.draft.id,
        expectedRevision: edited.revision,
        requestId: randomUUID(),
        reason: '合成完整复核',
        acknowledgeComplete: true,
      });
      const p = f.workspace.scores.publication.prepare({
        epoch: f.epoch,
        reviewId: review.reviewId,
      });
      f.workspace.scores.publication.confirm({
        epoch: f.epoch,
        reviewId: review.reviewId,
        token: p.token,
        expectedVersionId: p.expectedVersionId,
        reason: '合成复核入分',
        acknowledgePublish: true,
        acknowledgeReplacement: true,
      });
    }
    expect(() =>
      f.workspace.growth.confirmSummary(f.confirmation(pending.id, pending.revision)),
    ).toThrow('变化');
    const timeline = f.workspace.growth.timeline({
      epoch: f.epoch,
      studentId: f.request.studentId,
    });
    expect(timeline.entries[0]).toMatchObject({
      stale: true,
      record: { id: entry.entryId, content: '教师复核：本阶段完成订正练习；继续核实后续结果。' },
    });
    expect(timeline.summaries.find((s) => s.record.id === pending.id)?.stale).toBe(true);
    const next = reopen(f.workspace, f.root);
    expect(
      next.growth.timeline({ epoch: f.epoch, studentId: f.request.studentId }).entries[0]?.stale,
    ).toBe(true);
  },
);

test('formal correction creates a new entry, preserves parent and cannot be used as a source cycle', async () => {
  const f = await fixture(),
    draft = f.reviewed(),
    entry = f.workspace.growth.confirmSummary(f.confirmation(draft.id, draft.revision));
  const correction = f.manual('人工更正原阶段表述。', entry.entryId);
  const reviewed = f.workspace.growth.editSummary({
    epoch: f.epoch,
    id: correction.id,
    expectedRevision: 1,
    content: '教师复核更正：后续结果仍待核实。',
  });
  const result = f.workspace.growth.confirmSummary(f.confirmation(reviewed.id, reviewed.revision));
  const timeline = f.workspace.growth.timeline({ epoch: f.epoch, studentId: f.request.studentId });
  expect(timeline.entries).toHaveLength(2);
  expect(timeline.entries.find((e) => e.record.id === entry.entryId)?.supersededBy).toBe(
    result.entryId,
  );
  expect(() =>
    f.workspace.growth.prepare({
      ...f.prepareInput,
      selection: { ...f.selection, events: [{ id: result.entryId, revision: 1 }] },
    }),
  ).toThrow('修订不存在');
});

test('summary preparation expiry and restored epoch reject stale writes while exact sources survive backup', async () => {
  const f = await fixture(),
    prepared = f.workspace.growth.prepare(f.prepareInput);
  const timer = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
  expect(() =>
    f.workspace.growth.claim({ epoch: f.epoch, token: prepared.token, requestId: randomUUID() }),
  ).toThrow('失效');
  timer.mockRestore();
  const draft = f.reviewed();
  f.workspace.growth.confirmSummary(f.confirmation(draft.id, draft.revision));
  const oldBook = f.workspace.growth,
    preview = f.workspace.previewRestore(f.workspace.exportBackup({ epoch: f.epoch }));
  expect(preview).toMatchObject({
    growthEventCount: 1,
    growthSummaryCount: 1,
    growthEntryCount: 1,
  });
  const restored = f.workspace.commitRestore({ epoch: f.epoch, token: preview.token });
  expect(() => oldBook.timeline({ epoch: f.epoch, studentId: f.request.studentId })).toThrow(
    '切换',
  );
  const timeline = f.workspace.growth.timeline({
    epoch: restored.epoch,
    studentId: f.request.studentId,
  });
  expect(timeline.entries[0]?.record.source.selection.scores[0]?.versionId).toBe(f.score.versionId);
});

test.each(['summary-written', 'entry-written'] as const)(
  'confirmation fault at %s leaves draft and entry atomic',
  async (stage) => {
    let armed = false;
    const f = await fixture((point) => {
      if (armed && point === stage) throw Error('Synthetic transaction failure');
    });
    const draft = f.reviewed();
    armed = true;
    expect(() =>
      f.workspace.growth.confirmSummary(f.confirmation(draft.id, draft.revision)),
    ).toThrow('Synthetic');
    expect(
      f.workspace.growth.timeline({ epoch: f.epoch, studentId: f.request.studentId }).entries,
    ).toHaveLength(0);
    expect(f.workspace.growth.readSummary({ epoch: f.epoch, id: draft.id }).record.status).toBe(
      'draft',
    );
    armed = false;
    expect(
      f.workspace.growth.confirmSummary(f.confirmation(draft.id, draft.revision)).replayed,
    ).toBe(false);
  },
);

test('committed confirmation with lost response can be resolved by original draft after reopen', async () => {
  let armed = false;
  const f = await fixture((stage) => {
    if (armed && stage === 'committed') throw Error('Lost reply');
  });
  const draft = f.reviewed();
  armed = true;
  expect(() => f.workspace.growth.confirmSummary(f.confirmation(draft.id, draft.revision))).toThrow(
    'Lost reply',
  );
  const next = reopen(f.workspace, f.root),
    view = next.growth.readSummary({ epoch: f.epoch, id: draft.id });
  expect(view.entryId).not.toBeNull();
  expect(next.growth.confirmSummary(f.confirmation(draft.id, draft.revision))).toMatchObject({
    entryId: view.entryId,
    replayed: true,
  });
  expect(
    next.growth.timeline({ epoch: f.epoch, studentId: f.request.studentId }).entries,
  ).toHaveLength(1);
});

test.each(['entry-content', 'event-history', 'source-student', 'self-parent'] as const)(
  'rehashed backup refuses invalid growth semantics: %s',
  async (kind) => {
    const f = await fixture(),
      draft = f.reviewed();
    f.workspace.growth.confirmSummary(f.confirmation(draft.id, draft.revision));
    const bundle = JSON.parse(f.workspace.exportBackup({ epoch: f.epoch }).toString('utf8')),
      file = join(f.root, 'tampered.sqlite');
    writeFileSync(file, Buffer.from(bundle.database.base64, 'base64'));
    const db = new DatabaseSync(file);
    if (kind === 'event-history') db.exec('DELETE FROM growth_event_revisions');
    else {
      const table = kind === 'source-student' ? 'growth_summaries' : 'growth_summary_entries';
      const row = db.prepare(`SELECT id,payload FROM ${table}`).get()!;
      const payload = JSON.parse(String(row.payload));
      if (kind === 'entry-content') payload.content = '被篡改的正式结果';
      else if (kind === 'source-student')
        payload.source.selection.studentId = f.workspace
          .snapshot()
          .students.find((s) => s.id !== f.request.studentId)!.id;
      else payload.supersedesEntryId = payload.id;
      db.prepare(`UPDATE ${table} SET payload=? WHERE id=?`).run(
        JSON.stringify(payload),
        String(row.id),
      );
    }
    db.close();
    const bytes = readFileSync(file);
    bundle.database = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      base64: bytes.toString('base64'),
    };
    expect(() => f.workspace.previewRestore(Buffer.from(JSON.stringify(bundle)))).toThrow('成长');
    expect(f.workspace.snapshot().epoch).toBe(f.epoch);
  },
);
