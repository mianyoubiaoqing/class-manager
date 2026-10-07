import { useEffect, useRef, useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import type { Result, Snapshot, PublicError } from '../shared/contracts';
import type { ExamSummary, ScoreVersionView } from '../shared/score-commands';
import type { MaterialPreview, MaterialSummary, StoredMaterial } from '../shared/material-records';
import type { GradingRequest, GradingEvidence } from '../shared/grading';
import { GRADING_LIMITS } from '../shared/grading';
import type {
  RubricView,
  RubricRecord,
  GradingDraftView,
  GradingSummary,
  GradingPreparationView,
  GradingPagePreview,
  GradingAttemptView,
  GradingRevisionView,
} from '../shared/grading-records';
import {
  gradingHundredths,
  gradingScoreText,
  gradingRuleForm,
  gradingRubricFromForm,
  newGradingRule,
  type GradingRuleForm,
} from './grading-editor';
import { GradingRubricEditor } from './GradingRubricEditor';
import { GradingPages } from './GradingPages';
import { GradingRegion } from './GradingRegion';
import { GradingOutbound } from './GradingOutbound';
import { GradingRuleDetails } from './GradingRuleDetails';
import { ScorePublicationPanel } from './ScorePublicationPanel';
import './grading.css';

// 关联读取失败仍保留 Main 给出的类别及操作编号，不能误报为不确定的响应中断。
class GradingReadError extends Error {
  constructor(readonly detail: PublicError) {
    super(detail.message);
  }
}
const readErrorText = (error: PublicError) =>
  `${error.message}（${error.code} · ${error.operationId}）`;

/** 教师绑定合成答卷、确认外发范围及逐题复核；具名 IPC 执行存储和可取消生成。
 * 输入当前快照；向父页报告未保存或运行状态。冻结后由成绩模块预览确认正式入分，无自动付费重试。 */
export function GradingPage({
  snapshot,
  onDirtyChange,
  navigationBusy,
}: {
  snapshot: Snapshot;
  onDirtyChange: (dirty: boolean) => void;
  navigationBusy: boolean;
}) {
  const api = window.classManager,
    epoch = snapshot.epoch;
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [score, setScore] = useState<ScoreVersionView>();
  const [subjectId, setSubjectId] = useState(''),
    [studentId, setStudentId] = useState('');
  const [rubrics, setRubrics] = useState<RubricRecord[]>([]),
    [rubric, setRubric] = useState<RubricView>();
  const [rubricTitle, setRubricTitle] = useState(''),
    [rules, setRules] = useState<GradingRuleForm[]>();
  const [materials, setMaterials] = useState<MaterialSummary[]>([]),
    [material, setMaterial] = useState<StoredMaterial>(),
    [importPreview, setImportPreview] = useState<MaterialPreview>();
  const [fragmentId, setFragmentId] = useState(1);
  const [request, setRequest] = useState<GradingRequest>();
  const [pages, setPages] = useState<GradingRequest['pages']>([]),
    [selectedPages, setSelectedPages] = useState<string[]>([]),
    [selectedQuestions, setSelectedQuestions] = useState<string[]>([]);
  const [expectedPages, setExpectedPages] = useState(1),
    [bindingApproved, setBindingApproved] = useState(false),
    [syntheticApproved, setSyntheticApproved] = useState(false),
    [partialApproved, setPartialApproved] = useState(false);
  const [directory, setDirectory] = useState<GradingSummary[]>([]),
    [directoryOffset, setDirectoryOffset] = useState(0),
    [draft, setDraft] = useState<GradingDraftView>();
  const [baseReviewId, setBaseReviewId] = useState<string | null>(null);
  const [historicalRubric, setHistoricalRubric] = useState<RubricView>();
  const [currentPage, setCurrentPage] = useState(''),
    [original, setOriginal] = useState<string>(),
    [processed, setProcessed] = useState<GradingPagePreview>();
  const [prepared, setPrepared] = useState<GradingPreparationView>(),
    [outboundApproved, setOutboundApproved] = useState(false),
    [replaceApproved, setReplaceApproved] = useState(false),
    [expired, setExpired] = useState(false);
  const [questionId, setQuestionId] = useState(''),
    [edit, setEdit] = useState<{
      answer: string;
      score: string;
      reason: string;
      evidence: GradingEvidence[];
      reviewed: boolean;
    }>();
  const [attempts, setAttempts] = useState<GradingAttemptView[]>([]),
    [history, setHistory] = useState<GradingRevisionView[]>([]),
    [historyOffset, setHistoryOffset] = useState(0),
    [historical, setHistorical] = useState<GradingRevisionView>();
  const [freezeReason, setFreezeReason] = useState(''),
    [freezeApproved, setFreezeApproved] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState<{ error: boolean; text: string }>();
  const [publicationDirty, setPublicationDirty] = useState(false);
  const alive = useRef(true),
    running = useRef(false);
  const locked = busy || navigationBusy;
  const setupChanged =
    !!draft &&
    !!request &&
    JSON.stringify({
      ...request,
      pages,
      rubricVersionId: rubric?.record.id,
      scoreVersionId: score?.record.id,
      expectedAnswerPages: expectedPages,
      acknowledgePartial: partialApproved,
    }) !== JSON.stringify(draft.payload.request);
  const dirty =
    publicationDirty ||
    !!rules ||
    !!importPreview ||
    !!prepared ||
    !!edit ||
    busy ||
    setupChanged ||
    (!draft && pages.length > 0);
  const frozen = draft?.record.status === 'frozen';
  const subject = score?.payload.analysis.subjects.find((s) => s.id === subjectId);
  const roster =
    score?.payload.analysis.roster.filter((student) =>
      score.payload.analysis.groups.some(
        (g) => g.id === student.groupId && g.subjectIds.includes(subjectId),
      ),
    ) ?? [];
  const names = new Map(materials.map((m) => [m.record.id, m.record.name]));
  function clearPrepared() {
    setPrepared(undefined);
    setOutboundApproved(false);
    setReplaceApproved(false);
  }
  function changePages(value: GradingRequest['pages']) {
    setPages(value);
    setProcessed(undefined);
    setBindingApproved(false);
    setSyntheticApproved(false);
    clearPrepared();
  }
  async function run<T>(
    work: () => Promise<Result<T>>,
    accept: (value: T) => void | Promise<void>,
    success?: string,
  ) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await work();
      if (!alive.current) return;
      if (!result.ok) {
        setMessage({
          error: true,
          text: readErrorText(result.error),
        });
        return;
      }
      await accept(result.value);
      if (success && alive.current) setMessage({ error: false, text: success });
    } catch (error) {
      if (alive.current)
        setMessage({
          error: true,
          text:
            error instanceof GradingReadError
              ? readErrorText(error.detail)
              : error instanceof Error && error.message.startsWith('评分')
                ? error.message
                : '操作响应中断。请重新读取答卷和尝试记录核对；付费请求不会自动重试。',
        });
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const requireValue = <T,>(result: Result<T>) => {
    if (!result.ok) throw new GradingReadError(result.error);
    return result.value;
  };
  async function refresh() {
    const [examList, sources] = await Promise.all([
      api.listExams({ epoch }),
      api.listMaterials({ epoch }),
    ]);
    if (!alive.current) return;
    const examValues = requireValue(examList),
      sourceValues = requireValue(sources);
    setExams(examValues);
    setMaterials(sourceValues);
  }
  async function listDrafts(examId: string, offset = 0) {
    const result = await api.listGradings({ epoch, examId, includeFrozen: true, offset });
    if (alive.current) {
      setDirectory(requireValue(result));
      setDirectoryOffset(offset);
    }
  }
  async function listRubrics(examId: string, id: string) {
    const result = await api.listRubrics({ epoch, examId, subjectId: id });
    if (alive.current) setRubrics(requireValue(result));
  }
  async function loadDraft(id: string) {
    const view = requireValue(await api.readGrading({ epoch, id }));
    const [scoreView, ruleView, attemptList, revisionList] = await Promise.all([
      api.readScoreVersion({ epoch, versionId: view.payload.request.scoreVersionId }),
      api.readRubric({ epoch, id: view.payload.request.rubricVersionId }),
      api.gradingAttempts({ epoch, id }),
      api.gradingHistory({ epoch, id }),
    ]);
    const nextScore = requireValue(scoreView),
      nextRubric = requireValue(ruleView),
      nextAttempts = requireValue(attemptList),
      nextHistory = requireValue(revisionList);
    const [rubricList, draftList] = await Promise.all([
      api.listRubrics({
        epoch,
        examId: view.payload.request.examId,
        subjectId: view.payload.request.subjectId,
      }),
      api.listGradings({
        epoch,
        examId: view.payload.request.examId,
        includeFrozen: true,
        offset: directoryOffset,
      }),
    ]);
    const nextRubrics = requireValue(rubricList),
      nextDirectory = requireValue(draftList);
    if (!alive.current) return;
    setDraft(view);
    setBaseReviewId(null);
    setScore(nextScore);
    setRubric(nextRubric);
    setRubrics(nextRubrics);
    setDirectory(nextDirectory);
    setRequest(view.payload.request);
    setPages(view.payload.request.pages);
    setSubjectId(view.payload.request.subjectId);
    setStudentId(view.payload.request.studentId);
    setExpectedPages(view.payload.request.expectedAnswerPages);
    setPartialApproved(view.payload.request.acknowledgePartial);
    setSelectedPages(view.payload.request.selectedPageIds);
    setSelectedQuestions(view.payload.request.selectedQuestionIds);
    setBindingApproved(false);
    setSyntheticApproved(false);
    setAttempts(nextAttempts);
    setHistory(nextHistory);
    setHistoryOffset(0);
    setHistorical(undefined);
    setHistoricalRubric(undefined);
    setEdit(undefined);
    setQuestionId('');
    setOriginal(undefined);
    setProcessed(undefined);
    setCurrentPage(view.payload.request.pages[0]!.id);
    clearPrepared();
    setFreezeApproved(false);
    setFreezeReason('');
  }
  useEffect(() => {
    alive.current = true;
    void run(
      async () => {
        await refresh();
        return { ok: true, value: null };
      },
      () => {},
    );
    return () => {
      alive.current = false;
      onDirtyChange(false);
      void api.cancelGrading({ epoch }).catch(() => {});
      void api.cancelMaterial({ epoch }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!prepared) {
      setExpired(false);
      return;
    }
    const wait = Date.parse(prepared.expiresAt) - Date.now();
    setExpired(wait <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [prepared]);
  function buildRequest(): GradingRequest {
    if (!score || !rubric || !studentId || !subjectId || !syntheticApproved || !bindingApproved)
      throw new Error('评分前须确认合成材料、归属、角色、页序和细则版本。');
    return {
      examId: score.record.examId,
      scoreVersionId: score.record.id,
      subjectId,
      studentId,
      rubricVersionId: rubric.record.id,
      pages,
      expectedAnswerPages: expectedPages,
      selectedPageIds: selectedPages,
      selectedQuestionIds: selectedQuestions,
      acknowledgeSyntheticOnly: true,
      acknowledgeBindingAndOrder: true,
      acknowledgePartial: partialApproved,
    };
  }
  function selectPage(id: string) {
    setCurrentPage(id);
    setOriginal(undefined);
    setProcessed(undefined);
  }
  async function originalImage() {
    const page = (edit ? evidencePages : pages).find((p) => p.id === currentPage);
    if (!page) return;
    await run(
      () => api.readMaterialImage({ epoch, id: page.sourceVersionId, fragmentId: page.fragmentId }),
      setOriginal,
    );
  }
  async function cancel() {
    try {
      const [grade, source] = await Promise.all([
        api.cancelGrading({ epoch }),
        api.cancelMaterial({ epoch }),
      ]);
      if (!alive.current) return;
      requireValue(grade);
      requireValue(source);
      setMessage({ error: false, text: '已请求取消，保留已保存输入；可重新读取答卷和尝试核对。' });
    } catch (error) {
      if (alive.current)
        setMessage({
          error: true,
          text:
            error instanceof GradingReadError
              ? readErrorText(error.detail)
              : '取消响应中断。请重新读取答卷和尝试记录核对，付费请求不会自动重试。',
        });
    } finally {
      if (alive.current) clearPrepared();
    }
  }
  const shown = historical?.payload ?? draft?.payload;
  const shownRubric = historicalRubric ?? rubric;
  const evidencePages = historical?.payload.request.pages ?? pages;
  const evidenceReadonly = !!frozen || !!historical;
  const readyCount =
    shown?.rows.filter((r) => r.reviewed && r.status === 'suggested' && r.scoreHundredths !== null)
      .length ?? 0;
  return (
    <div className={`grading-workspace ${!score ? 'grading-start' : ''}`}>
      <p className="notice">
        仅使用合成材料。AI
        提供逐题建议，教师对照原图核对；冻结复核后，须另行核对入分差异并确认，才写入正式成绩。
      </p>
      {message && (
        <div
          className={`notice ${message.error ? 'error' : 'success'}`}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </div>
      )}
      <div className="grading-toolbar">
        <button
          disabled={locked || dirty}
          onClick={() =>
            void run(
              async () => {
                await refresh();
                if (score) await listDrafts(score.record.examId, directoryOffset);
                return { ok: true, value: null };
              },
              () => {},
            )
          }
        >
          刷新目录
        </button>
        <button
          disabled={locked || !!edit || !!rules || !!importPreview}
          onClick={() =>
            void run(
              () => api.cancelGrading({ epoch }),
              () => {
                setDraft(undefined);
                setBaseReviewId(null);
                setRequest(undefined);
                setPages([]);
                setSelectedPages([]);
                setSelectedQuestions([]);
                clearPrepared();
                setHistorical(undefined);
                setProcessed(undefined);
                setOriginal(undefined);
                setBindingApproved(false);
              },
            )
          }
        >
          新建 / 放弃未保存答卷设置
        </button>
        {(busy || prepared) && <button onClick={() => void cancel()}>取消准备或生成</button>}
      </div>
      <section className="panel">
        <h2>考试、科目和学生</h2>
        <div className="grading-grid">
          <label>
            考试
            <select
              value={score?.record.examId ?? ''}
              disabled={locked || !!draft || !!rules || pages.length > 0}
              onChange={(e) => {
                const exam = exams.find((x) => x.examId === e.target.value);
                if (exam)
                  void run(
                    () => api.readScoreVersion({ epoch, versionId: exam.versionId }),
                    async (view) => {
                      setScore(view);
                      setSubjectId('');
                      setStudentId('');
                      setRubric(undefined);
                      setRubrics([]);
                      await listDrafts(view.record.examId);
                    },
                  );
              }}
            >
              <option value="">选择已有考试</option>
              {exams.map((e) => (
                <option key={e.examId} value={e.examId}>
                  {e.definition.name} · {e.definition.className} · {e.definition.date}
                </option>
              ))}
            </select>
          </label>
          <label>
            科目
            <select
              value={subjectId}
              disabled={locked || !!draft || !!rules || pages.length > 0}
              onChange={(e) => {
                const id = e.target.value;
                setSubjectId(id);
                setStudentId('');
                setRubric(undefined);
                if (score && id)
                  void run(
                    async () => {
                      await listRubrics(score.record.examId, id);
                      return { ok: true, value: null };
                    },
                    () => {},
                  );
              }}
            >
              <option value="">选择科目</option>
              {score?.payload.analysis.subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · 满分 {s.maxScore}
                </option>
              ))}
            </select>
          </label>
          <label>
            学生
            <select
              value={studentId}
              disabled={locked || !!draft}
              onChange={(e) => {
                setStudentId(e.target.value);
                setBindingApproved(false);
              }}
            >
              <option value="">明确选择学生</option>
              {roster.map((s) => (
                <option key={s.studentId} value={s.studentId}>
                  {s.studentNumber} · {s.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!exams.length && <p>请先在成绩管理创建合成考试与科目，未录入成绩也可用于绑定答卷。</p>}
        {score && (
          <p>
            考试版本 {score.record.revision} {score.stale ? '· 已有更新版本' : '· 当前版本'}
          </p>
        )}
        {draft && (
          <button
            disabled={locked || !!edit || !!rules || frozen}
            onClick={() =>
              void run(
                () => api.readScoreVersion({ epoch, versionId: score!.latestVersionId }),
                async (view) => {
                  setScore(view);
                  clearPrepared();
                  setBindingApproved(false);
                  await listRubrics(view.record.examId, subjectId);
                },
              )
            }
          >
            读取当前考试版本以重新绑定
          </button>
        )}
      </section>
      {!score && (
        <section className="panel grading-empty-preview" aria-label="答卷预览">
          <header>
            <h2>答卷预览</h2>
            <p>先选择考试、科目和学生，再导入答卷资料。</p>
          </header>
          <div className="workspace-empty-guide">
            <FileCheck2 size={40} />
            <h3>还没有待复核答卷</h3>
            <p>准备评分依据和答卷后，助手提供建议，你确认后才会入分。</p>
          </div>
        </section>
      )}
      {score && (
        <section className="panel">
          <h2>答卷目录</h2>
          <div className="grading-directory">
            {directory.map((entry) => (
              <button
                key={entry.record.id}
                disabled={locked || dirty}
                onClick={() =>
                  void run(
                    async () => {
                      await loadDraft(entry.record.id);
                      return { ok: true, value: null };
                    },
                    () => {},
                  )
                }
              >
                {score.payload.analysis.roster.find((s) => s.studentId === entry.studentId)
                  ?.displayName ??
                  snapshot.students.find((s) => s.id === entry.studentId)?.displayName ??
                  '原考试学生'}{' '}
                ·{' '}
                {score.payload.analysis.subjects.find((s) => s.id === entry.subjectId)?.name ??
                  '原考试科目'}{' '}
                · {entry.record.status === 'frozen' ? '已冻结复核' : '草案'} · 修订{' '}
                {entry.record.revision}
              </button>
            ))}
          </div>
          <button
            disabled={locked || dirty || directoryOffset === 0}
            onClick={() =>
              void run(
                async () => {
                  await listDrafts(score.record.examId, Math.max(0, directoryOffset - 50));
                  return { ok: true, value: null };
                },
                () => {},
              )
            }
          >
            上一页
          </button>
          <button
            disabled={locked || dirty || directory.length < 50}
            onClick={() =>
              void run(
                async () => {
                  await listDrafts(score.record.examId, directoryOffset + 50);
                  return { ok: true, value: null };
                },
                () => {},
              )
            }
          >
            下一页
          </button>
        </section>
      )}
      {subject && (
        <section className="panel">
          <h2>评分细则</h2>
          <label>
            细则版本
            <select
              value={rubric?.record.id ?? ''}
              disabled={locked || frozen || !!historical || !!rules || !!edit}
              onChange={(e) => {
                if (e.target.value)
                  void run(
                    () => api.readRubric({ epoch, id: e.target.value }),
                    (view) => {
                      setRubric(view);
                      setSelectedQuestions(view.definition.questions.map((q) => q.id));
                      setBindingApproved(false);
                      clearPrepared();
                    },
                  );
              }}
            >
              <option value="">明确选择细则版本</option>
              {rubrics.map((r) => (
                <option key={r.id} value={r.id}>
                  细则版本 {r.revision} · {new Date(r.createdAt).toLocaleString('zh-CN')}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={locked || frozen || !!historical || !!rules || !!edit}
            onClick={() => {
              setRubricTitle(rubric?.definition.title ?? `${subject.name}评分细则`);
              setRules(
                rubric
                  ? rubric.definition.questions.map(gradingRuleForm)
                  : [
                      {
                        ...newGradingRule(gradingScoreText(gradingHundredths(subject.maxScore, 2))),
                        label: '第 1 题',
                        stepScore: gradingScoreText(10 ** (2 - subject.precision)),
                      },
                    ],
              );
            }}
          >
            新建细则版本
          </button>
          {rules && (
            <>
              <GradingRubricEditor
                title={rubricTitle}
                onTitle={setRubricTitle}
                questions={rules}
                onChange={setRules}
                disabled={locked}
              />
              <button
                disabled={locked}
                onClick={() =>
                  void run(
                    () =>
                      api.createRubric({
                        epoch,
                        requestId: crypto.randomUUID(),
                        scoreVersionId: score!.record.id,
                        subjectId,
                        definition: gradingRubricFromForm(rubricTitle, rules, subject),
                      }),
                    async (receipt) => {
                      const view = requireValue(await api.readRubric({ epoch, id: receipt.id }));
                      if (!alive.current) return;
                      setRubric(view);
                      setRules(undefined);
                      setSelectedQuestions(view.definition.questions.map((q) => q.id));
                      setBindingApproved(false);
                      clearPrepared();
                      await listRubrics(score!.record.examId, subjectId);
                    },
                    '评分细则已保存为新版本，既有审核须核对来源。',
                  )
                }
              >
                保存细则版本
              </button>
              <button disabled={locked} onClick={() => setRules(undefined)}>
                放弃细则编辑
              </button>
            </>
          )}
          {rubric && !rules && (
            <p>
              {rubric.definition.title} · 版本 {rubric.record.revision} ·{' '}
              {rubric.definition.questions.length} 题 · 满分{' '}
              {gradingScoreText(rubric.definition.maxHundredths)}
            </p>
          )}
          {shownRubric && !rules && (
            <details>
              <summary>
                {historical
                  ? '历史修订完整评分细则'
                  : frozen
                    ? '冻结复核完整评分细则'
                    : '查看完整评分细则'}
              </summary>
              <GradingRuleDetails questions={shownRubric.definition.questions} />
            </details>
          )}
        </section>
      )}
      {rubric && !rules && (
        <section className="panel">
          <h2>材料、角色与页序</h2>
          {(frozen || historical) && (
            <ol>
              {evidencePages.map((p, index) => (
                <li key={p.id}>
                  第 {index + 1} 页 · {names.get(p.sourceVersionId) ?? '保存的原材料'} · 图{' '}
                  {p.fragmentId} ·{' '}
                  {p.role === 'student_answer'
                    ? '学生答卷'
                    : p.role === 'question_material'
                      ? '题目材料'
                      : '细则材料'}{' '}
                  · 旋转 {p.rotation}° · 遮盖 {p.redactions.length} 处
                </li>
              ))}
            </ol>
          )}
          {!frozen && !historical && (
            <>
              <div className="grading-toolbar">
                <button
                  disabled={locked || !!importPreview}
                  onClick={() =>
                    void run(
                      () => api.previewMaterial({ epoch }),
                      async (view) => {
                        if (!view) return;
                        if (!['jpg', 'png', 'pdf'].includes(view.version.format)) {
                          await api.cancelMaterial({ epoch });
                          setMessage({ error: true, text: '答卷材料仅支持 JPG、PNG 和 PDF。' });
                          return;
                        }
                        setImportPreview(view);
                      },
                      undefined,
                    )
                  }
                >
                  导入合成图像 / PDF
                </button>
                <label>
                  已保存材料
                  <select
                    disabled={locked || !!importPreview}
                    value={material?.record.id ?? ''}
                    onChange={(e) => {
                      if (e.target.value)
                        void run(
                          () => api.readMaterial({ epoch, id: e.target.value }),
                          (view) => {
                            setMaterial(view);
                            setFragmentId(
                              view.version.fragments.find((f) => f.kind === 'image')?.id ?? 1,
                            );
                          },
                        );
                    }}
                  >
                    <option value="">选择材料</option>
                    {materials
                      .filter((m) => ['jpg', 'png', 'pdf'].includes(m.format))
                      .map((m) => (
                        <option key={m.record.id} value={m.record.id}>
                          {m.record.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              {importPreview && (
                <div className="notice">
                  <p>
                    {importPreview.name} ·{' '}
                    {importPreview.version.completeness === 'partial'
                      ? '解析不完整，须核对可读页面'
                      : '已准备预览'}
                  </p>
                  {importPreview.version.warnings.map((warning, i) => (
                    <p key={i}>{warning}</p>
                  ))}
                  <button
                    disabled={locked}
                    onClick={() =>
                      void run(
                        () =>
                          api.confirmMaterial({
                            epoch,
                            token: importPreview.token,
                            requestId: crypto.randomUUID(),
                          }),
                        async (receipt) => {
                          const view = requireValue(
                            await api.readMaterial({ epoch, id: receipt.id }),
                          );
                          setMaterial(view);
                          setImportPreview(undefined);
                          setFragmentId(
                            view.version.fragments.find((f) => f.kind === 'image')?.id ?? 1,
                          );
                          await refresh();
                        },
                        '合成材料已保存。',
                      )
                    }
                  >
                    确认保存材料
                  </button>
                  <button
                    disabled={locked}
                    onClick={() =>
                      void run(
                        () => api.cancelMaterial({ epoch }),
                        () => setImportPreview(undefined),
                      )
                    }
                  >
                    取消导入
                  </button>
                </div>
              )}
              {material && (
                <div className="grading-toolbar">
                  <label>
                    图像页
                    <select
                      value={fragmentId}
                      disabled={locked}
                      onChange={(e) => setFragmentId(Number(e.target.value))}
                    >
                      {material.version.fragments
                        .filter((f) => f.kind === 'image')
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            图像 {f.id}{' '}
                            {f.locator.kind === 'page' ? `· 第 ${f.locator.index} 页` : ''}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    disabled={
                      locked ||
                      pages.length >= GRADING_LIMITS.pages ||
                      pages.some(
                        (p) =>
                          p.sourceVersionId === material.version.id && p.fragmentId === fragmentId,
                      )
                    }
                    onClick={() => {
                      const page = {
                        id: crypto.randomUUID(),
                        role: 'student_answer' as const,
                        sourceVersionId: material.version.id,
                        fragmentId,
                        rotation: 0 as const,
                        crop: { x: 0, y: 0, width: 1, height: 1 },
                        redactions: [],
                      };
                      changePages([...pages, page]);
                      if (selectedPages.length < 8) setSelectedPages([...selectedPages, page.id]);
                      selectPage(page.id);
                    }}
                  >
                    加入答卷
                  </button>
                </div>
              )}
              <GradingPages
                pages={pages}
                onChange={changePages}
                selected={selectedPages}
                onSelected={(ids) => {
                  setSelectedPages(ids);
                  clearPrepared();
                }}
                current={currentPage}
                onCurrent={selectPage}
                original={original}
                readOriginal={() => void originalImage()}
                disabled={locked || !!edit}
                names={names}
              />
              <label>
                预计学生答卷页数
                <input
                  type="number"
                  min="1"
                  max="20"
                  disabled={locked || !!edit}
                  value={expectedPages}
                  onChange={(e) => {
                    setExpectedPages(Number(e.target.value));
                    setBindingApproved(false);
                    clearPrepared();
                  }}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={partialApproved}
                  onChange={(e) => {
                    setPartialApproved(e.target.checked);
                    setBindingApproved(false);
                    clearPrepared();
                  }}
                />
                若材料解析不完整，已人工核对可读范围
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={syntheticApproved}
                  onChange={(e) => setSyntheticApproved(e.target.checked)}
                />
                确认仅为合成材料
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={bindingApproved}
                  onChange={(e) => setBindingApproved(e.target.checked)}
                />
                已核对考试、科目、学生、角色、页序和细则版本
              </label>
              <button
                disabled={
                  locked || !!edit || !bindingApproved || !syntheticApproved || !pages.length
                }
                onClick={() =>
                  void run(
                    () =>
                      draft
                        ? api.rebindGrading({
                            epoch,
                            id: draft.record.id,
                            expectedRevision: draft.record.revision,
                            request: buildRequest(),
                          })
                        : api.createGrading({
                            epoch,
                            requestId: crypto.randomUUID(),
                            request: buildRequest(),
                            baseReviewId,
                          }),
                    async (receipt) => loadDraft(receipt.id),
                    draft ? '答卷依据已重新绑定，变化的来源须重新审核。' : '答卷输入已保存。',
                  )
                }
              >
                {draft ? '确认重新绑定（变化将清除审核）' : '保存答卷输入'}
              </button>
            </>
          )}
        </section>
      )}
      {draft && rubric && (
        <section className="panel">
          {historical && (
            <p className="notice">
              历史修订 {historical.record.revision} · 细则 {shownRubric?.definition.title} / 版本{' '}
              {shownRubric?.record.revision} · 材料 {evidencePages.length}{' '}
              页。以下作答与图像均来自此修订。
            </p>
          )}
          <h2>{frozen ? '已冻结复核' : '逐题建议与人工复核'}</h2>
          <p>
            {draft.stale || setupChanged ? '来源已变化，请先重新绑定当前依据。' : '来源已核对'} ·
            修订 {draft.record.revision} · 已复核 {readyCount}/{shown?.rows.length ?? 0} 题
          </p>
          {!frozen && !historical && (
            <>
              <div className="grading-questions">
                {rubric.definition.questions.map((q) => (
                  <label key={q.id}>
                    <input
                      type="checkbox"
                      disabled={locked || !!edit || setupChanged}
                      checked={selectedQuestions.includes(q.id)}
                      onChange={(e) => {
                        setSelectedQuestions(
                          e.target.checked
                            ? [...selectedQuestions, q.id]
                            : selectedQuestions.filter((id) => id !== q.id),
                        );
                        clearPrepared();
                      }}
                    />
                    {q.label}
                  </label>
                ))}
              </div>
              <label>
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={replaceApproved}
                  onChange={(e) => {
                    setReplaceApproved(e.target.checked);
                    setPrepared(undefined);
                    setOutboundApproved(false);
                  }}
                />
                若本批包含已审核题目，同意替换本批建议并重新审核
              </label>
              <button
                disabled={
                  locked ||
                  !!edit ||
                  setupChanged ||
                  draft.stale ||
                  !selectedPages.length ||
                  !selectedQuestions.length
                }
                onClick={() =>
                  void run(
                    () =>
                      api.prepareGrading({
                        epoch,
                        id: draft.record.id,
                        expectedRevision: draft.record.revision,
                        selectedPageIds: selectedPages,
                        selectedQuestionIds: selectedQuestions,
                        acknowledgeReplaceReviewed: replaceApproved,
                      }),
                    (view) => {
                      setPrepared(view);
                      setOutboundApproved(false);
                    },
                    '实际外发预览已准备；尚未调用模型。',
                  )
                }
              >
                准备本批实际外发预览
              </button>
              {prepared && (
                <GradingOutbound
                  prepared={prepared}
                  rubric={rubric}
                  locked={locked}
                  expired={expired}
                  approved={outboundApproved}
                  onApprove={setOutboundApproved}
                  onCancel={() => void cancel()}
                  onGenerate={() => {
                    const packet = prepared;
                    clearPrepared();
                    void run(
                      () =>
                        api.generateGrading({
                          epoch,
                          token: packet.token,
                          wireHash: packet.wireHash,
                          acknowledgeOutboundPreview: true,
                        }),
                      async (receipt) => loadDraft(receipt.id),
                      '本批建议已保存，仍须教师逐题核对。',
                    );
                  }}
                />
              )}
            </>
          )}
          <div className="grading-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>题目</th>
                  <th>作答 / 依据</th>
                  <th>建议分</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {shown?.rows.map((row) => (
                  <tr key={row.questionId}>
                    <td>
                      {shownRubric?.definition.questions.find((q) => q.id === row.questionId)
                        ?.label ?? row.questionId}
                    </td>
                    <td>
                      <p>{row.answer ?? '无法判定'}</p>
                      <p>{row.reason}</p>
                      <small>
                        来源：
                        {row.origin === 'teacher'
                          ? '教师'
                          : row.origin === 'rule'
                            ? '本地规则'
                            : '模型'}{' '}
                        · 置信度{' '}
                        {row.confidence === null
                          ? '未知'
                          : `${Math.round(row.confidence * 100)}%（模型自报）`}
                      </small>
                    </td>
                    <td>
                      {row.scoreHundredths === null
                        ? '待人工'
                        : gradingScoreText(row.scoreHundredths)}
                    </td>
                    <td>
                      {row.status === 'pending'
                        ? '待人工处理'
                        : row.reviewed
                          ? '已复核'
                          : '待教师复核'}
                    </td>
                    <td>
                      <button
                        disabled={
                          locked || !!edit || (!evidenceReadonly && (setupChanged || draft.stale))
                        }
                        onClick={() => {
                          setQuestionId(row.questionId);
                          setCurrentPage(
                            row.evidence[0]?.pageId ??
                              evidencePages.find((p) => p.role === 'student_answer')!.id,
                          );
                          setOriginal(undefined);
                          setProcessed(undefined);
                          setEdit({
                            answer: row.answer ?? '',
                            score:
                              row.scoreHundredths === null
                                ? ''
                                : gradingScoreText(row.scoreHundredths),
                            reason: row.reason,
                            evidence: row.evidence,
                            reviewed: false,
                          });
                        }}
                      >
                        {evidenceReadonly ? '查看原图依据' : '核对 / 补评'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {edit && (
            <div className="grading-question-editor">
              <h3>
                {shownRubric?.definition.questions.find((q) => q.id === questionId)?.label} ·{' '}
                {evidenceReadonly ? '只读依据' : '教师核对'}
              </h3>
              <label>
                依据页面
                <select
                  disabled={locked}
                  value={currentPage}
                  onChange={(e) => selectPage(e.target.value)}
                >
                  {evidencePages.map(
                    (p, index) =>
                      p.role === 'student_answer' && (
                        <option value={p.id} key={p.id}>
                          学生答卷第 {index + 1} 页
                        </option>
                      ),
                  )}
                </select>
              </label>
              <div className="grading-toolbar">
                <button disabled={locked} onClick={() => void originalImage()}>
                  对照原图
                </button>
                <button
                  disabled={locked}
                  onClick={() =>
                    void run(
                      () =>
                        api.previewGradingPage({
                          epoch,
                          id: draft.record.id,
                          pageId: currentPage,
                          revision: historical?.record.revision,
                        }),
                      setProcessed,
                    )
                  }
                >
                  读取处理后图像 / 定位依据
                </button>
              </div>
              <div className="grading-image-pair">
                <div>
                  <h4>本地原图</h4>
                  <GradingRegion image={original} label="复核原图" rectangles={[]} />
                </div>
                <div>
                  <h4>实际处理后图像</h4>
                  <GradingRegion
                    image={processed?.pageId === currentPage ? processed.dataUrl : undefined}
                    label="作答依据"
                    rectangles={edit.evidence
                      .filter((e) => e.pageId === currentPage)
                      .map((e) => e.rectangle)}
                    disabled={locked || evidenceReadonly || edit.evidence.length >= 8}
                    onSelect={
                      evidenceReadonly
                        ? undefined
                        : (rectangle) =>
                            setEdit({
                              ...edit,
                              evidence: [...edit.evidence, { pageId: currentPage, rectangle }],
                              reviewed: false,
                            })
                    }
                  />
                </div>
              </div>
              {edit.evidence.map((e, index) => (
                <p key={index}>
                  依据 {index + 1} · 答卷第 {evidencePages.findIndex((p) => p.id === e.pageId) + 1}{' '}
                  页{' '}
                  <button
                    disabled={locked || evidenceReadonly}
                    onClick={() =>
                      setEdit({
                        ...edit,
                        evidence: edit.evidence.filter((_, i) => i !== index),
                        reviewed: false,
                      })
                    }
                  >
                    移除依据
                  </button>
                </p>
              ))}
              {!evidenceReadonly && (
                <>
                  <label>
                    核对后的作答
                    <textarea
                      disabled={locked}
                      value={edit.answer}
                      maxLength={4000}
                      onChange={(e) =>
                        setEdit({ ...edit, answer: e.target.value, reviewed: false })
                      }
                    />
                  </label>
                  <label>
                    教师评分
                    <input
                      inputMode="decimal"
                      disabled={locked}
                      value={edit.score}
                      onChange={(e) => setEdit({ ...edit, score: e.target.value, reviewed: false })}
                    />
                  </label>
                  <label>
                    可核对的评分依据
                    <textarea
                      disabled={locked}
                      value={edit.reason}
                      maxLength={2000}
                      onChange={(e) =>
                        setEdit({ ...edit, reason: e.target.value, reviewed: false })
                      }
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      disabled={locked}
                      checked={edit.reviewed}
                      onChange={(e) => setEdit({ ...edit, reviewed: e.target.checked })}
                    />
                    已对照原图核对本题作答、对应关系、分值和依据
                  </label>
                  <button
                    disabled={
                      locked ||
                      !edit.reviewed ||
                      !edit.evidence.length ||
                      !edit.reason.trim() ||
                      draft.stale ||
                      setupChanged
                    }
                    onClick={() =>
                      void run(
                        () =>
                          api.editGrading({
                            epoch,
                            id: draft.record.id,
                            expectedRevision: draft.record.revision,
                            edits: [
                              {
                                questionId,
                                answer: edit.answer,
                                scoreHundredths: gradingHundredths(
                                  edit.score,
                                  rubric.definition.precision,
                                ),
                                reason: edit.reason,
                                evidence: edit.evidence,
                                acknowledgeReviewed: true,
                              },
                            ],
                          }),
                        async (receipt) => loadDraft(receipt.id),
                        '本题人工复核已保存。',
                      )
                    }
                  >
                    保存本题复核
                  </button>
                </>
              )}
              <button disabled={locked} onClick={() => setEdit(undefined)}>
                {evidenceReadonly ? '关闭依据查看' : '放弃本题未保存修改'}
              </button>
            </div>
          )}
          {!frozen && !historical && (
            <div className="grading-freeze">
              <h3>冻结完整复核</h3>
              <p>
                只有所有题目已人工复核、答卷页数完整、来源仍有效时才能冻结。未决题目不能计零或冒充总分。
              </p>
              <label>
                复核说明
                <input
                  disabled={locked || !!edit}
                  maxLength={500}
                  value={freezeReason}
                  onChange={(e) => {
                    setFreezeReason(e.target.value);
                    setFreezeApproved(false);
                  }}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={locked || !!edit}
                  checked={freezeApproved}
                  onChange={(e) => setFreezeApproved(e.target.checked)}
                />
                已核对完整答卷及逐题分数，同意冻结本次复核
              </label>
              <button
                disabled={
                  locked ||
                  !!edit ||
                  setupChanged ||
                  draft.stale ||
                  !freezeApproved ||
                  !freezeReason.trim() ||
                  readyCount !== draft.payload.rows.length ||
                  pages.filter((p) => p.role === 'student_answer').length !== expectedPages
                }
                onClick={() =>
                  void run(
                    () =>
                      api.freezeGrading({
                        epoch,
                        id: draft.record.id,
                        expectedRevision: draft.record.revision,
                        requestId: crypto.randomUUID(),
                        reason: freezeReason,
                        acknowledgeComplete: true,
                      }),
                    async () => loadDraft(draft.record.id),
                    '完整复核已冻结，尚未写入正式成绩。',
                  )
                }
              >
                确认冻结复核
              </button>
            </div>
          )}
          {frozen && !historical && (
            <>
              <p className="notice success">
                冻结复核总分{' '}
                {gradingScoreText(
                  draft.payload.rows.reduce((sum, r) => sum + r.scoreHundredths!, 0),
                )}
                。原版本不可修改，正式入分须另行核对差异并确认。
              </p>
              {draft.reviewId && (
                <ScorePublicationPanel
                  key={`${epoch}/${draft.reviewId}`}
                  epoch={epoch}
                  reviewId={draft.reviewId}
                  labels={{
                    students: Object.fromEntries(
                      snapshot.students.map((s) => [s.id, `${s.studentNumber} · ${s.displayName}`]),
                    ),
                    subjects: Object.fromEntries(
                      (score?.payload.analysis.subjects ?? []).map((s) => [s.id, s.name]),
                    ),
                    exams: score ? { [score.record.examId]: score.payload.definition.name } : {},
                  }}
                  blocked={locked || !!edit || setupChanged || !!rules}
                  onBusyChange={setBusy}
                  onDirtyChange={setPublicationDirty}
                  onPublished={() => loadDraft(draft.record.id)}
                />
              )}
              <button
                disabled={locked || !!edit || !draft.reviewId}
                onClick={() =>
                  void run(
                    () => api.readScoreVersion({ epoch, versionId: score!.latestVersionId }),
                    async (view) => {
                      setBaseReviewId(draft.reviewId);
                      setDraft(undefined);
                      setRequest(undefined);
                      setScore(view);
                      setBindingApproved(false);
                      setSyntheticApproved(false);
                      setHistorical(undefined);
                      setHistoricalRubric(undefined);
                      clearPrepared();
                      await listRubrics(view.record.examId, subjectId);
                    },
                    '已准备修订答卷设置；请选择当前细则、重新确认归属并保存。旧冻结复核保持不变。',
                  )
                }
              >
                从此冻结复核创建修订草案
              </button>
            </>
          )}
        </section>
      )}
      {draft && (
        <section className="panel">
          <h2>尝试与不可变历史</h2>
          <button
            disabled={locked || !!edit || setupChanged || !!rules}
            onClick={() =>
              void run(
                async () => {
                  await loadDraft(draft.record.id);
                  return { ok: true, value: null };
                },
                () => {},
              )
            }
          >
            重新读取答卷与尝试
          </button>
          <ul>
            {attempts.map((a) => (
              <li key={a.record.id}>
                {new Date(a.record.startedAt).toLocaleString('zh-CN')} ·{' '}
                {
                  {
                    running: '生成中',
                    succeeded: '本批建议已保存',
                    failed: '失败',
                    cancelled: '已取消',
                    interrupted: '重开后中断',
                  }[a.record.status]
                }{' '}
                · {a.payload.request.selectedQuestionIds.length} 题 /{' '}
                {a.payload.request.selectedPageIds.length} 页 · Token{' '}
                {a.payload.provider?.usage?.totalTokens ?? '未知'}{' '}
                {a.record.errorCode ? `· ${a.record.errorCode}` : ''}
              </li>
            ))}
          </ul>
          <div className="grading-directory">
            {history.map((h) => (
              <button
                disabled={locked || !!edit || setupChanged}
                key={h.record.revision}
                onClick={() =>
                  void run(
                    () => api.readRubric({ epoch, id: h.payload.request.rubricVersionId }),
                    (view) => {
                      setHistorical(h);
                      setHistoricalRubric(view);
                      setOriginal(undefined);
                      setProcessed(undefined);
                    },
                  )
                }
              >
                修订 {h.record.revision} ·{' '}
                {
                  {
                    created: '创建',
                    edited: '人工复核',
                    rebound: '重新绑定',
                    generated: '生成建议',
                    frozen: '冻结复核',
                  }[h.record.operation]
                }
              </button>
            ))}
          </div>
          <button
            disabled={locked || !!edit || historyOffset === 0}
            onClick={() =>
              void run(
                () =>
                  api.gradingHistory({
                    epoch,
                    id: draft.record.id,
                    offset: Math.max(0, historyOffset - 50),
                  }),
                (items) => {
                  setHistory(items);
                  setHistoryOffset(Math.max(0, historyOffset - 50));
                },
              )
            }
          >
            历史上一页
          </button>
          <button
            disabled={locked || !!edit || history.length < 50}
            onClick={() =>
              void run(
                () =>
                  api.gradingHistory({ epoch, id: draft.record.id, offset: historyOffset + 50 }),
                (items) => {
                  setHistory(items);
                  setHistoryOffset(historyOffset + 50);
                },
              )
            }
          >
            历史下一页
          </button>
          {historical && (
            <p className="notice">
              当前只读查看修订 {historical.record.revision}，旧记录不可修改。
              <button
                disabled={locked || !!edit}
                onClick={() => {
                  setHistorical(undefined);
                  setHistoricalRubric(undefined);
                  setOriginal(undefined);
                  setProcessed(undefined);
                }}
              >
                返回当前答卷
              </button>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
