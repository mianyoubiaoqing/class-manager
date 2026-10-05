import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ConversationPrivacy } from '../src/core/conversation-privacy';
import { Workspace } from '../src/core/workspace';
import { growthMessages } from '../src/core/growth-source';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('RED-001 tool facts redact family, financial and health details without changing local data', () => {
  const original = {
    summaryFact: '父母离异，母亲失业，家庭贫困，抑郁症；数学90分，完成3次作业。',
    nested: { content: '低保户、单亲家庭，需要心理辅导。学习有困难，课堂发言积极。' },
  };
  const saved = structuredClone(original);
  const safe = JSON.stringify(new ConversationPrivacy().toolResult(original));
  for (const detail of ['离异', '失业', '贫困', '抑郁', '低保', '单亲', '心理辅导'])
    expect(safe).not.toContain(detail);
  expect(safe).toContain('数学90分');
  expect(safe).toContain('完成3次作业');
  expect(safe).toContain('学习有困难');
  expect(original).toEqual(saved);
});

test('large context privacy processing is bounded on long non-email words', () => {
  const input = 'a'.repeat(300000) + ' teacher@example.com';
  const start = performance.now();
  const output = new ConversationPrivacy().text(input);
  expect(output).not.toContain('teacher@example.com');
  expect(output).toContain('[邮箱已隐藏]');
  expect(performance.now() - start).toBeLessThan(2000);
});

test('RED-002 restart removes orphan backup staging without touching business workspaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-red-team-'));
  roots.push(root);
  const first = new Workspace(root);
  first.seedDemo({ epoch: first.snapshot().epoch });
  const before = first.snapshot();
  first.close();
  const orphan = join(root, 'staging', randomUUID());
  mkdirSync(join(orphan, 'assets'), { recursive: true });
  writeFileSync(join(orphan, 'snapshot.sqlite'), 'unfinished synthetic backup');
  const unknown = join(root, 'staging', 'user-kept-note');
  mkdirSync(unknown);
  writeFileSync(join(unknown, 'note.txt'), 'keep');
  const restarted = new Workspace(root);
  try {
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(unknown)).toBe(true);
    expect(restarted.snapshot().classes).toEqual(before.classes);
    expect(restarted.snapshot().students).toEqual(before.students);
    expect(restarted.snapshot().epoch).toBe(before.epoch);
  } finally {
    restarted.close();
  }
});

test('RED-002 cleanup does not follow UUID junctions or links nested in orphan directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-staging-link-'));
  roots.push(root);
  const first = new Workspace(root);
  first.close();
  const outside = join(root, 'teacher-kept');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  const link = join(root, 'staging', randomUUID());
  symlinkSync(outside, link, 'junction');
  const orphan = join(root, 'staging', randomUUID());
  mkdirSync(orphan);
  symlinkSync(outside, join(orphan, 'nested'), 'junction');
  const restarted = new Workspace(root);
  try {
    expect(existsSync(link)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  } finally {
    restarted.close();
  }
});

test('RED-001 dedicated growth outbound path masks sensitive facts while immutable local source hashes stay valid', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-growth-redaction-'));
  roots.push(root);
  const w = new Workspace(root),
    snapshot = w.seedDemo({ epoch: w.snapshot().epoch }),
    student = snapshot.students[0]!;
  const event = w.growth.saveEvent({
    epoch: snapshot.epoch,
    studentId: student.id,
    requestId: randomUUID(),
    reason: '虚构事实',
    content: {
      date: '2026-10-04',
      kind: 'event',
      description: '仅供本机查看',
      source: '合成',
      action: '',
      result: '',
      followUp: 'none',
      summaryFact: '父母离异，家庭困难，需要心理辅导；数学90分',
    },
  });
  const selection = {
    studentId: student.id,
    from: '2026-10-01',
    to: '2026-10-04',
    events: [{ id: event.id, revision: event.revision }],
    scores: [],
  };
  const manual = w.growth.createManual({
    epoch: snapshot.epoch,
    requestId: randomUUID(),
    selection,
    acknowledgeSyntheticOnly: true,
    acknowledgeRedacted: true,
    content: '教师本地总结',
  });
  const prepared = w.growth.prepare({
    epoch: snapshot.epoch,
    selection,
    acknowledgeSyntheticOnly: true,
    acknowledgeRedacted: true,
  });
  const wire = JSON.stringify(growthMessages(prepared.packet));
  for (const text of ['离异', '家庭困难', '心理辅导']) expect(wire).not.toContain(text);
  expect(wire).toContain('数学90分');
  const hash = w.growth.readSummary({ epoch: snapshot.epoch, id: manual.id }).record.inputHash;
  w.close();
  const reopened = new Workspace(root);
  try {
    expect(
      reopened.growth.readSummary({ epoch: snapshot.epoch, id: manual.id }).record.inputHash,
    ).toBe(hash);
    expect(
      reopened.growth.timeline({ epoch: snapshot.epoch, studentId: student.id }).events[0]?.content
        .summaryFact,
    ).toContain('离异');
  } finally {
    reopened.close();
  }
});
