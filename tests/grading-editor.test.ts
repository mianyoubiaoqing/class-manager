import { expect, test } from 'vitest';
import {
  gradingHundredths,
  gradingScoreText,
  gradingRuleForm,
  gradingRubricFromForm,
  gradingDragRectangle,
} from '../src/renderer/grading-editor';
import { validateRubric } from '../src/core/grading';
import type { RubricDefinition } from '../src/shared/grading';

test('teacher scores preserve exact hundredths and reject rounding, empty and unsupported forms', () => {
  expect(gradingHundredths('12.35', 2)).toBe(1235);
  expect(gradingHundredths('0', 0)).toBe(0);
  expect(gradingHundredths('7.5', 1)).toBe(750);
  for (const value of ['', '-1', '1e3', '1.001', 'NaN', '1,5'])
    expect(() => gradingHundredths(value, 2)).toThrow();
  expect(() => gradingHundredths('1.5', 0)).toThrow();
  expect(() => gradingHundredths('1.25', 1)).toThrow();
  expect(gradingScoreText(0)).toBe('0');
  expect(gradingScoreText(1235)).toBe('12.35');
});

test('all six teacher rule forms round-trip stable identity, per-kind rules, full score and precision', () => {
  const base = { maxHundredths: 200, stepHundredths: 50, label: '重复题号', prompt: '合成题干' };
  const definition: RubricDefinition = {
    title: '合成细则',
    precision: 2,
    maxHundredths: 1200,
    questions: [
      { ...base, id: 'single', kind: 'single_choice', options: ['A', 'B'], correct: 'B' },
      {
        ...base,
        id: 'multi',
        kind: 'multiple_choice',
        options: ['A', 'B', 'C'],
        correct: ['A', 'C'],
        partial: { mode: 'per_correct', hundredths: 50 },
      },
      {
        ...base,
        id: 'judge',
        kind: 'judgement',
        correct: ['是', 'TRUE'],
        incorrect: ['否', 'FALSE'],
      },
      {
        ...base,
        id: 'blank',
        kind: 'blank',
        accepted: ['red, blue', '蓝色'],
        normalization: { ignoreCase: true, collapseWhitespace: false },
      },
      { ...base, id: 'short', kind: 'short_text', scoringPoints: '两个关键点分别给一分。' },
      { ...base, id: 'manual', kind: 'manual', explanation: '合成公式仅由教师判分。' },
    ],
  };
  const rebuilt = gradingRubricFromForm(
    definition.title,
    definition.questions.map(gradingRuleForm),
    {
      id: '10000000-0000-4000-8000-000000000001',
      name: '合成学科',
      maxScore: '12.00',
      precision: 2,
    },
  );
  expect(rebuilt).toEqual(definition);
  expect(validateRubric(rebuilt)).toEqual(definition);
});

test('image selection handles reverse dragging and out-of-image motion but refuses zero or invalid areas', () => {
  expect(gradingDragRectangle({ x: 0.75, y: 0.8 }, { x: 0.25, y: 0.2 })).toEqual({
    x: 0.25,
    y: 0.2,
    width: 0.5,
    height: 0.6000000000000001,
  });
  expect(gradingDragRectangle({ x: -1, y: -1 }, { x: 2, y: 2 })).toEqual({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  expect(gradingDragRectangle({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeNull();
  expect(gradingDragRectangle({ x: NaN, y: 0 }, { x: 1, y: 1 })).toBeNull();
});
