import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { BusinessPreview, ChangeValue, teacherReceipt } from '../src/renderer/ConversationPreview';

test('business preview hides internal IDs and version parameters but keeps real objects and content', () => {
  const html = renderToStaticMarkup(
    createElement(BusinessPreview, {
      value: {
        epoch: 'secret-epoch',
        token: 'secret-token',
        operationRef: 'secret-operation',
        expectedRevision: 4,
        sourceHash: 'secret-hash',
        promptVersion: 'business-agent-v8',
        id: '9b315e74-51c0-448f-874b-c23313f06d55',
        classId: '七年级一班',
        studentId: '张同学（1001）',
        request: { subject: '英语', durationMinutes: 40 },
        content: { objectives: ['学会阅读'], notes: '先复习上节课' },
        active: true,
      },
    }),
  );
  for (const value of [
    'secret-',
    'expectedRevision',
    'sourceHash',
    'business-agent-v8',
    '9b315e74',
  ])
    expect(html).not.toContain(value);
  for (const value of [
    '七年级一班',
    '张同学',
    '1001',
    '英语',
    '40',
    '学会阅读',
    '先复习上节课',
    '在籍',
  ])
    expect(html).toContain(value);
});
test('large arrays provide readable pagination and a truthful total rather than truncated JSON', () => {
  const html = renderToStaticMarkup(
    createElement(ChangeValue, {
      text: JSON.stringify(
        Array.from({ length: 45 }, (_, index) => ({ name: `岗位${index + 1}` })),
      ),
    }),
  );
  expect(html).toContain('共45项');
  expect(html).toContain('岗位20');
  expect(html).not.toContain('岗位21');
  expect(html).toContain('下一组');
  expect(html).not.toContain('<pre');
});
test('tool receipts use ordinary teacher language and plain descriptions remain readable', () => {
  expect(teacherReceipt('已获得 confirmScorePublication 的业务回执。')).toBe('正式入分已完成。');
  expect(teacherReceipt('已获得 createLessonDraft 的业务回执。')).toBe('新建课时已完成。');
  expect(
    renderToStaticMarkup(createElement(ChangeValue, { text: '班级改名为七年级一班' })),
  ).toContain('班级改名为七年级一班');
});
