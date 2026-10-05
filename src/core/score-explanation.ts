import { createHash } from 'node:crypto';
import type { ScoreVersionView } from '../shared/score-commands';
import {
  EXPLANATION_LIMITS,
  EXPLANATION_PROMPT_VERSION,
  EXPLANATION_METRICS,
  explanationOutputSchema,
  explanationSelectionSchema,
  explanationWireSchema,
  type ExplanationFact,
  type ExplanationMetric,
  type ExplanationOutput,
  type ExplanationPacket,
} from '../shared/score-explanation';
import { DomainError } from './errors';
import { calculateScoreStatistics, presentSubjectScore } from './scores';
import type { ScoreValue } from '../shared/scores';

export { EXPLANATION_METRICS } from '../shared/score-explanation';
const metricDependencies: Partial<Record<ExplanationMetric, ExplanationMetric[]>> = {
  mean: ['fullScore', 'validCount'],
  median: ['fullScore', 'validCount'],
  minimum: ['fullScore', 'validCount'],
  maximum: ['fullScore', 'validCount'],
  targetRatePercent: ['targetScore', 'targetMetCount', 'targetDenominator'],
  studentScore: ['fullScore', 'studentStatus'],
  studentRatePercent: ['fullScore', 'studentScore', 'studentStatus'],
};

/** Only call with a version loaded by ScoreBook; never accept a renderer-supplied version payload. */
export function prepareExplanation(
  view: ScoreVersionView,
  rawSelection: unknown,
): ExplanationPacket {
  return createExplanationPreparer(view)(rawSelection);
}

/** A validation pass may check many drafts from one source; snapshot and compute that source once. */
export function createExplanationPreparer(
  view: ScoreVersionView,
): (selection: unknown) => ExplanationPacket {
  if (view.stale) throw new DomainError('STALE', '成绩已有新版本，请选择最新版本生成解释。');
  const source = { record: structuredClone(view.record), payload: structuredClone(view.payload) };
  const analysis = source.payload.analysis;
  // Never trust the caller's statistics object, even when reusing a historical source.
  const statistics = calculateScoreStatistics({
    ...analysis,
    roster: analysis.roster.map(({ studentId, groupId }) => ({ studentId, groupId })),
  });
  const studentIds = new Set(analysis.roster.map((student) => student.studentId));
  const scores = new Map<string, ScoreValue>(
    analysis.entries.map((entry) => [`${entry.studentId}:${entry.subjectId}`, entry.score]),
  );
  return (rawSelection) => prepareFromSource(source, statistics, studentIds, scores, rawSelection);
}

function prepareFromSource(
  view: Pick<ScoreVersionView, 'record' | 'payload'>,
  statistics: ScoreVersionView['statistics'],
  studentIds: ReadonlySet<string>,
  scores: ReadonlyMap<string, ScoreValue>,
  rawSelection: unknown,
): ExplanationPacket {
  const selection = explanationSelectionSchema.parse(rawSelection);
  if (
    new Set(selection.subjectIds).size !== selection.subjectIds.length ||
    new Set(selection.metrics).size !== selection.metrics.length
  )
    throw new DomainError('EXPLANATION_SELECTION', '科目和指标不能重复。');
  const analysis = view.payload.analysis;
  const subjects = selection.subjectIds.map((id) => {
    const subject = analysis.subjects.find((item) => item.id === id);
    if (!subject) throw new DomainError('EXPLANATION_SELECTION', '所选科目不在此成绩版本中。');
    return subject;
  });
  const scope = selection.scope;
  if (scope.kind === 'student' && !studentIds.has(scope.studentId))
    throw new DomainError('EXPLANATION_SELECTION', '学生不在此考试的历史应考名册中。');
  for (const metric of selection.metrics) {
    const supported = EXPLANATION_METRICS[metric].scope;
    if (supported !== 'both' && supported !== scope.kind)
      throw new DomainError('EXPLANATION_SELECTION', '所选指标与班级或学生范围不匹配。');
    const missing = (metricDependencies[metric] ?? []).filter(
      (dependency) => !selection.metrics.includes(dependency),
    );
    if (missing.length)
      throw new DomainError(
        'EXPLANATION_CONTEXT',
        `${EXPLANATION_METRICS[metric].label}还需要同时选择：${missing.map((dependency) => EXPLANATION_METRICS[dependency].label).join('、')}。`,
      );
  }
  const facts: ExplanationFact[] = [];
  for (const [index, subject] of subjects.entries()) {
    const summary = statistics.subjects.find((item) => item.subjectId === subject.id)!;
    const score =
      scope.kind === 'student'
        ? (scores.get(`${scope.studentId}:${subject.id}`) ?? { status: 'missing' as const })
        : null;
    const student = score ? presentSubjectScore(score, subject) : null;
    const values: Record<ExplanationMetric, ExplanationFact['value']> = {
      fullScore: subject.maxScore,
      expectedCount: summary.expectedCount,
      validCount: summary.validCount,
      absentCount: summary.absentCount,
      missingCount: summary.missingCount,
      notSelectedCount: summary.notSelectedCount,
      mean: summary.mean,
      median: summary.median,
      minimum: summary.minimum,
      maximum: summary.maximum,
      targetScore: summary.target?.score ?? null,
      targetMetCount: summary.target?.metCount ?? null,
      targetDenominator: summary.target?.denominator ?? null,
      targetRatePercent: summary.target?.ratePercent ?? null,
      studentScore: student?.displayScore ?? null,
      studentStatus: score?.status ?? null,
      studentRatePercent: student?.ratePercent ?? null,
    };
    for (const metric of selection.metrics) {
      facts.push({
        id: `F${String(facts.length + 1).padStart(3, '0')}`,
        subject: `S${String(index + 1).padStart(2, '0')}`,
        subjectId: subject.id,
        subjectName: subject.name,
        metric,
        value: values[metric],
        label: EXPLANATION_METRICS[metric].label,
        unit: EXPLANATION_METRICS[metric].unit,
      });
    }
  }
  // Deliberate allowlist: custom subject names, identities and exam metadata never leave the machine.
  const wire = explanationWireSchema.parse({
    formatVersion: 1,
    scope: scope.kind,
    facts: facts.map(({ id, subject, metric, value }) => ({ id, subject, metric, value })),
  });
  const json = JSON.stringify(wire);
  if (Buffer.byteLength(json) > EXPLANATION_LIMITS.inputBytes)
    throw new DomainError('EXPLANATION_LIMIT', '所选解释指标超过请求上限。');
  return {
    sourceVersionId: view.record.id,
    examId: view.record.examId,
    sourceRevision: view.record.revision,
    selection,
    facts,
    wire,
    inputHash: createHash('sha256').update(json).digest('hex'),
    promptVersion: EXPLANATION_PROMPT_VERSION,
  };
}

/** Facts are exact references. Free prose remains explicitly unverified model supplementation. */
export function validateExplanationOutput(
  raw: string,
  packet: ExplanationPacket,
): ExplanationOutput {
  if (Buffer.byteLength(raw) > EXPLANATION_LIMITS.outputBytes)
    throw new DomainError('EXPLANATION_INVALID', '模型解释超过长度上限，未保存。');
  let output: ExplanationOutput;
  try {
    output = explanationOutputSchema.parse(JSON.parse(raw));
  } catch {
    throw new DomainError('EXPLANATION_INVALID', '模型解释格式不符合要求，未保存。');
  }
  const facts = new Map(packet.wire.facts.map((fact) => [fact.id, fact]));
  const seen = new Set<string>();
  for (const observation of output.observations) {
    const fact = facts.get(observation.factId);
    if (!fact || fact.value !== observation.value || seen.has(observation.factId))
      throw new DomainError(
        'EXPLANATION_FACT_MISMATCH',
        '模型引用不存在、重复或改写了统计数值，未保存。',
      );
    seen.add(observation.factId);
  }
  for (const proposal of [...output.interpretations, ...output.questions, ...output.actions]) {
    if (
      new Set(proposal.evidenceIds).size !== proposal.evidenceIds.length ||
      proposal.evidenceIds.some((id) => !facts.has(id))
    )
      throw new DomainError('EXPLANATION_FACT_MISMATCH', '模型补充缺少有效的本地依据，未保存。');
  }
  return output;
}

export function explanationMessages(
  packet: ExplanationPacket,
): Array<{ role: 'system' | 'user'; content: string }> {
  const wire = explanationWireSchema.parse(packet.wire);
  const content = JSON.stringify(wire);
  if (Buffer.byteLength(content) > EXPLANATION_LIMITS.inputBytes)
    throw new DomainError('EXPLANATION_LIMIT', '所选解释指标超过请求上限。');
  return [
    {
      role: 'system',
      content: [
        '你是教师的成绩解释草案助手。输入是程序计算的统计事实，只能使用提供的 facts。',
        '输出必须是 JSON 对象，不要 Markdown。结构：',
        '{"formatVersion":1,"observations":[{"factId":"F001","value":null}],"interpretations":[{"text":"待核实解释","evidenceIds":["F001"],"uncertainty":"不确定性"}],"questions":[{"text":"教师核实问题","evidenceIds":["F001"]}],"actions":[{"text":"未执行的跟进建议","evidenceIds":["F001"]}],"limitations":["资料限制"]}',
        'observations 只选真实存在的 factId，value 逐字逐类型复制，不得自行计算、修改或补零。',
        'interpretations 是可能的解释而非事实，每条须明确不确定性；questions/actions 必须附有效证据ID。',
        '没有题目级数据，不得编造知识点掌握、具体错题原因、学生品德或心理状态、能力变化或升学概率。',
        '不得将建议说成已执行，不发送通知，不做正式成长评价。资料不足时写入 limitations，其他补充数组可为空。',
        'null 表示不适用或无有效数据，不能转为零。百分比的分母以给定指标为准。',
        'S01 等为本次请求内科目代号，不猜测学校、学生姓名、考试名称或实际学科。',
        '限制：observations 1至40条，其余补充数组各最多12条；每段最多1200字符；limitations 1至8条。',
      ].join('\n'),
    },
    { role: 'user', content },
  ];
}
