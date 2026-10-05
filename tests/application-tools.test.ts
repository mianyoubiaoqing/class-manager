import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ApplicationTools, applicationResultPage } from '../src/main/application-tools';
import { ConversationPrivacy } from '../src/core/conversation-privacy';
import { Workspace } from '../src/core/workspace';
import {
  applicationToolNames,
  applicationReadTools,
  applicationDraftTools,
} from '../src/shared/application-tools';
import { CHANNELS } from '../src/shared/contracts';

const fixtures: Array<{ workspace: Workspace; root: string }> = [];
afterEach(() => {
  for (const { workspace, root } of fixtures.splice(0)) {
    workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cm-application-tools-'));
  const workspace = new Workspace(root);
  fixtures.push({ workspace, root });
  const epoch = workspace.snapshot().epoch;
  workspace.createClass({ epoch, name: '工具合成班' });
  const classId = workspace.snapshot().classes[0]!.id;
  workspace.saveStudent({ epoch, classId, studentNumber: 'SYN01', displayName: '工具合成学生' });
  const snapshot = workspace.snapshot();
  const privacy = new ConversationPrivacy();
  privacy.register(snapshot);
  const tools = new ApplicationTools(privacy);
  return { workspace, snapshot, privacy, tools, classId, student: snapshot.students[0]! };
}

test('catalog describes every callable tool with the real parameter schema and confirmation boundary', () => {
  const { tools } = fixture();
  const catalog = tools.catalog();
  expect(catalog).toHaveLength(applicationToolNames.length);
  expect(new Set(applicationToolNames).size).toBe(applicationToolNames.length);
  for (const entry of catalog) {
    expect(CHANNELS).toContain(entry.tool);
    expect(entry.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    expect(JSON.stringify(entry.parameters)).not.toContain('"epoch"');
    expect(JSON.stringify(entry.parameters)).not.toContain('"expectedRevision"');
    expect(entry.mode).toBe(
      (applicationReadTools as readonly string[]).includes(entry.tool)
        ? 'read'
        : (applicationDraftTools as readonly string[]).includes(entry.tool)
          ? 'draft'
          : 'confirm',
    );
  }
  expect(tools.capabilities()).toMatchObject({
    features: expect.any(Array),
    workflows: expect.any(Array),
  });
  expect(tools.capabilities('readScoreVersion')).toHaveLength(1);
});

test('local confirmation resolves remembered slide and version IDs to readable titles', () => {
  const f = fixture(),
    slideId = randomUUID(),
    versionId = randomUUID();
  f.tools.remember('readLessonVersion', {
    id: versionId,
    title: '英语第一课',
    content: { slides: [{ id: slideId, title: '阅读导入', notes: '复习词汇' }] },
  });
  expect(f.tools.preview({ classId: f.classId, versionId, slideIds: [slideId] })).toEqual({
    classId: '工具合成班',
    versionId: '英语第一课',
    slideIds: ['阅读导入'],
  });
});

test('read real score details after discovering an opaque version reference, preserving grades and hiding identities', async () => {
  const f = fixture();
  const subjectId = randomUUID(),
    groupId = randomUUID();
  const preview = await f.workspace.scores.preview(Buffer.from('学生编号,数学\nSYN01,99'), {
    epoch: f.snapshot.epoch,
    classId: f.classId,
    expectedRevision: 0,
    definition: {
      name: '工具合成考试',
      date: '2026-10-03',
      academicYear: '2026-2027',
      term: '上学期',
      grade: '高一',
    },
    subjects: [{ id: subjectId, name: '数学', maxScore: '150', precision: 2 }],
    groups: [{ id: groupId, name: '数学组', subjectIds: [subjectId] }],
    assignments: [{ studentId: f.student.id, groupId }],
    scoreBasis: 'raw',
    format: 'csv',
    fileName: 'synthetic.csv',
  });
  const receipt = f.workspace.scores.confirm({
    epoch: f.snapshot.epoch,
    token: preview.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '工具回归',
  });
  const catalog = f.privacy.toolResult(
    f.tools.remember('listExams', f.workspace.scores.list({ epoch: f.snapshot.epoch })),
  ) as Array<{ versionId: string }>;
  const invocation = f.tools.prepare(
    { kind: 'tool', tool: 'readScoreVersion', args: { versionId: catalog[0]!.versionId } },
    f.snapshot,
  );
  expect(invocation.input.versionId).toBe(receipt.versionId);
  const detail = f.workspace.scores.read(invocation.input);
  const safe = f.privacy.toolResult(f.tools.remember('readScoreVersion', detail));
  const wire = JSON.stringify(safe);
  for (const raw of [
    f.student.id,
    f.student.displayName,
    f.student.studentNumber,
    receipt.examId,
    receipt.versionId,
    subjectId,
    groupId,
  ])
    expect(wire).not.toContain(raw);
  expect(wire).toContain('99.00');
  expect(wire).toContain('9900');
  expect(wire).toContain('数学');
});

test('seat prepare, randomize and confirm reuse only locally captured tokens and versions', () => {
  const f = fixture();
  const prepared = f.tools.prepare(
    {
      kind: 'tool',
      tool: 'prepareSeating',
      args: {
        classId: '[班级1]',
        source: { kind: 'empty', layout: { rows: 1, columns: 1, unavailable: [] } },
      },
    },
    f.snapshot,
  );
  const draft = f.workspace.seating.prepare(prepared.input);
  expect(f.workspace.seating.history({ epoch: f.snapshot.epoch, classId: f.classId })).toHaveLength(
    0,
  );
  const safe = f.privacy.toolResult(f.tools.remember('prepareSeating', draft)) as {
    operationRef: string;
  };
  expect(JSON.stringify(safe)).not.toContain(draft.token);
  const adjust = f.tools.prepare(
    {
      kind: 'tool',
      tool: 'adjustSeating',
      args: { operationRef: safe.operationRef, change: { kind: 'randomize' } },
    },
    f.snapshot,
  );
  const arranged = f.workspace.seating.adjust(adjust.input);
  const ready = f.privacy.toolResult(f.tools.remember('adjustSeating', arranged)) as {
    operationRef: string;
  };
  const confirm = f.tools.prepare(
    {
      kind: 'tool',
      tool: 'confirmSeating',
      args: { operationRef: ready.operationRef, reason: '教师确认合成座位' },
    },
    f.snapshot,
  );
  const receipt = f.workspace.seating.confirm(confirm.input);
  expect(
    f.workspace.seating.read({ epoch: f.snapshot.epoch, versionId: receipt.versionId }).payload
      .arrangement.assignments[0]!.studentId,
  ).toBe(f.student.id);
});

test('large draft metadata retains operation references and excludes oversized text from the field index', () => {
  const page = applicationResultPage({
    operationRef: '[记录1]',
    complete: true,
    draft: Array.from({ length: 500 }, () => ({ text: '学'.repeat(100) })),
    privateText: '学'.repeat(20000),
  });
  expect(page).toMatchObject({
    operationRef: '[记录1]',
    complete: true,
    fields: expect.any(Array),
  });
  expect(JSON.stringify(page)).not.toContain('学'.repeat(100));
});

test('a bound growth edit preserves the version read earlier and rejects a later writer instead of overwriting', () => {
  const f = fixture();
  const content = {
    date: '2026-10-03',
    kind: 'event' as const,
    description: '合成事实',
    source: '教师观察',
    action: '',
    result: '',
    followUp: 'none' as const,
    summaryFact: '',
  };
  const receipt = f.workspace.growth.saveEvent({
    epoch: f.snapshot.epoch,
    requestId: randomUUID(),
    studentId: f.student.id,
    content,
    reason: '创建',
  });
  f.tools.remember(
    'growthTimeline',
    f.workspace.growth.timeline({ epoch: f.snapshot.epoch, studentId: f.student.id }),
  );
  const id = f.privacy.recordReference(receipt.id);
  const bound = f.tools.prepare(
    {
      kind: 'tool',
      tool: 'saveGrowthEvent',
      args: {
        id,
        studentId: '[学生1]',
        content: { ...content, description: '拟修改' },
        reason: '核对',
      },
    },
    f.snapshot,
  );
  expect(bound.input.expectedRevision).toBe(1);
  f.workspace.growth.saveEvent({
    epoch: f.snapshot.epoch,
    requestId: randomUUID(),
    id: receipt.id,
    expectedRevision: 1,
    studentId: f.student.id,
    content: { ...content, description: '另一个已保存修改' },
    reason: '另外修改',
  });
  expect(() => f.workspace.growth.saveEvent(bound.input)).toThrow(/版本|变化/);
  expect(
    f.workspace.growth.timeline({ epoch: f.snapshot.epoch, studentId: f.student.id }).events[0]!
      .content.description,
  ).toBe('另一个已保存修改');
});

test.each(['epoch', 'expectedRevision', 'requestId', 'token', 'expectedVersionId'])(
  'model cannot supply controlled field %s',
  (field) => {
    const { tools, snapshot } = fixture();
    expect(() =>
      tools.prepare(
        { kind: 'tool', tool: 'createClass', args: { name: '合成班', [field]: randomUUID() } },
        snapshot,
      ),
    ).toThrow('本地管理');
  },
);

test('raw UUIDs, invented aliases and unrecognized arguments are refused', () => {
  const { tools, snapshot, student } = fixture();
  for (const id of [student.id, '[学生999]'])
    expect(() =>
      tools.prepare(
        { kind: 'tool', tool: 'setStudentActive', args: { id, active: false } },
        snapshot,
      ),
    ).toThrow();
  expect(() =>
    tools.prepare(
      { kind: 'tool', tool: 'snapshot', args: { sql: 'select * from students' } },
      snapshot,
    ),
  ).toThrow('不支持参数');
});

test('an alias used as free text becomes a local name instead of a raw UUID', () => {
  const { tools, snapshot, student } = fixture();
  const command = tools.prepare(
    { kind: 'tool', tool: 'createClass', args: { name: '[学生1]' } },
    snapshot,
  );
  expect(command.input.name).toContain(student.displayName);
  expect(command.input.name).not.toContain(student.id);
});

test('structured result paging offers every page and nested field without exposing omitted bytes', () => {
  const rows = Array.from({ length: 137 }, (_, index) => ({ grade: index }));
  const page1 = applicationResultPage(
    { payload: { rows } },
    { path: ['payload', 'rows'], offset: 0, limit: 100 },
  );
  expect(page1).toMatchObject({ total: 137, nextOffset: 100, items: expect.any(Array) });
  const page2 = applicationResultPage(
    { payload: { rows } },
    { path: ['payload', 'rows'], offset: 100, limit: 100 },
  );
  expect(page2).toMatchObject({ total: 137, nextOffset: null });
  expect((page2 as { items: unknown[] }).items).toHaveLength(37);
  const large = { notes: '合成内容'.repeat(18000) };
  expect(applicationResultPage(large)).toMatchObject({
    fields: [{ key: 'notes', type: 'string' }],
  });
  expect(applicationResultPage(large, { path: ['notes'], offset: 16000, limit: 30 })).toMatchObject(
    { offset: 16000, nextOffset: 32000, totalCharacters: 72000 },
  );
  expect(() => applicationResultPage(large, { path: ['__proto__'], offset: 0, limit: 30 })).toThrow(
    '不存在',
  );
});
