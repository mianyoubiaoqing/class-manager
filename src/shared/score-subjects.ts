import type { ScoreSubject } from './scores';

// Stable identifiers keep student histories comparable across imports.
export const SUBJECT_CATALOG: ScoreSubject[] = [
  '语文',
  '数学',
  '英语',
  '物理',
  '化学',
  '生物学',
  '思想政治',
  '历史',
  '地理',
  '日语',
  '俄语',
].map((name, index) => ({
  id: `c1000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  name,
  maxScore: index < 3 || index > 8 ? '150' : '100',
  precision: 0,
}));
