import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileUp, Plus, RefreshCw, Save, X } from 'lucide-react';
import type { DesktopApi, Result, Snapshot } from '../shared/contracts';
import type {
  ExamSummary,
  ScoreVersionView,
  SelectedScorePreview,
  StudentScoreHistory,
} from '../shared/score-commands';
import type { StoredScoreVersion } from '../shared/score-records';
import { ScoreConfiguration } from './ScoreConfiguration';
import { ScorePreview } from './ScorePreview';
import { ScoreResults } from './ScoreResults';
import { ScoreExplanation } from './ScoreExplanation';
import { correctionDraft, newExam, scoreText, type ExamDraft } from './score-editor';
import './scores.css';

type ConfirmCommand = Parameters<DesktopApi['confirmScores']>[0];

export function ScorePage({
  snapshot,
  onDirtyChange,
  navigationBusy,
  onRoster,
  onUnifiedImport,
  selectedClass,
  initialVersionId,
}: {
  snapshot: Snapshot;
  onDirtyChange: (dirty: boolean) => void;
  navigationBusy: boolean;
  onRoster?: () => void;
  onUnifiedImport?: () => void;
  selectedClass?: string;
  initialVersionId?: string;
}) {
  const api = window.classManager;
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [draft, setDraft] = useState<ExamDraft>();
  const [preview, setPreview] = useState<SelectedScorePreview>();
  const [previewCurrent, setPreviewCurrent] = useState(false);
  const [fileToken, setFileToken] = useState<string>();
  const [version, setVersion] = useState<ScoreVersionView>();
  const [history, setHistory] = useState<StoredScoreVersion[]>([]);
  const [studentHistory, setStudentHistory] = useState<StudentScoreHistory>();
  const [studentId, setStudentId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [reason, setReason] = useState('');
  const [command, setCommand] = useState<ConfirmCommand>();
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const [busy, setBusy] = useState('');
  const [now, setNow] = useState(Date.now());
  const sequence = useRef(0);
  const locked = useRef(false);
  const [examPage, setExamPage] = useState(0);
  const [examFilter, setExamFilter] = useState('');
  const [explanationDirty, setExplanationDirty] = useState(false);
  const updateExplanationDirty = useCallback(
    (dirty: boolean) => {
      setExplanationDirty(dirty);
      onDirtyChange(dirty);
    },
    [onDirtyChange],
  );
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  async function run<T>(label: string, work: () => Promise<Result<T>>, accept: (value: T) => void) {
    if (locked.current || explanationDirty) return;
    locked.current = true;
    const task = ++sequence.current;
    setBusy(label);
    setMessage(undefined);
    try {
      const result = await work();
      if (task !== sequence.current) return;
      if (result.ok) accept(result.value);
      else
        setMessage({
          text: `${result.error.message}（${result.error.code} · ${result.error.operationId}）`,
          error: true,
        });
    } catch {
      if (task === sequence.current)
        setMessage({
          text: '操作响应中断。确认入库时请使用原请求重试，勿重复新建考试。',
          error: true,
        });
    } finally {
      if (task === sequence.current) {
        locked.current = false;
        setBusy('');
      }
    }
  }

  useEffect(() => {
    let disposed = false;
    locked.current = false;
    setBusy('');
    setDraft(undefined);
    setPreview(undefined);
    setPreviewCurrent(false);
    setFileToken(undefined);
    setVersion(undefined);
    setHistory([]);
    setStudentHistory(undefined);
    setCommand(undefined);
    void api
      .listExams({
        epoch: snapshot.epoch,
        ...(snapshot.classes.some((c) => c.id === selectedClass) ? { classId: selectedClass } : {}),
      })
      .then((result) => {
        if (disposed) return;
        if (result.ok) {
          setExams(result.value);
          if (initialVersionId && result.value.some((exam) => exam.versionId === initialVersionId))
            openVersion(initialVersionId);
        } else setMessage({ text: result.error.message, error: true });
      })
      .catch(() => {
        if (!disposed) setMessage({ text: '无法读取考试记录。', error: true });
      });
    return () => {
      disposed = true;
      sequence.current++;
      locked.current = false;
      void api.cancelScorePreview({ epoch: snapshot.epoch }).catch(() => {});
    };
  }, [api, snapshot, selectedClass, initialVersionId]);

  useEffect(() => {
    if (!preview?.expiresAt) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()) + 10,
    );
    return () => clearTimeout(timer);
  }, [preview?.expiresAt]);

  function invalidate() {
    setPreviewCurrent(false);
    setCommand(undefined);
    void api.cancelScorePreview({ epoch: snapshot.epoch, keepSelectedFile: true }).catch(() => {});
  }
  function change(configuration: ExamDraft['configuration']) {
    if (locked.current) return;
    invalidate();
    setDraft((current) => (current ? { ...current, configuration } : current));
  }
  function startDraft(value: ExamDraft) {
    if (explanationDirty) return;
    invalidate();
    setDraft(value);
    setPreview(undefined);
    setFileToken(undefined);
    setVersion(undefined);
    setHistory([]);
    setStudentHistory(undefined);
    setReason('');
    setMessage(undefined);
  }
  function chooseFile(reuse: boolean) {
    if (!draft || locked.current) return;
    setPreviewCurrent(false);
    setCommand(undefined);
    const configuration = reuse
      ? draft.configuration
      : { ...draft.configuration, exclusions: [], columnMappings: [] };
    if (!reuse) {
      setFileToken(undefined);
      setPreview(undefined);
      setDraft({ ...draft, configuration });
    }
    void run(
      '正在预览',
      () =>
        api.previewScores({
          ...configuration,
          ...(reuse && fileToken ? { fileToken } : {}),
        }),
      (value) => {
        if (!value) {
          setMessage({ text: '已取消文件选择。', error: false });
          return;
        }
        setPreview(value);
        setFileToken(value.fileToken);
        setPreviewCurrent(true);
        setNow(Date.now());
      },
    );
  }
  function openVersion(versionId: string) {
    void run(
      '读取成绩',
      () => api.readScoreVersion({ epoch: snapshot.epoch, versionId }),
      (value) => {
        setVersion(value);
        setDraft(undefined);
        setPreview(undefined);
        setFileToken(undefined);
        setHistory([]);
        setStudentHistory(undefined);
        setStudentId(value.payload.analysis.roster[0]?.studentId ?? '');
        setSubjectId(value.payload.analysis.subjects[0]?.id ?? '');
        const task = sequence.current;
        void api
          .scoreHistory({ epoch: snapshot.epoch, examId: value.record.examId })
          .then((result) => {
            if (sequence.current !== task) return;
            if (result.ok) setHistory(result.value);
            else setMessage({ text: result.error.message, error: true });
          })
          .catch(() => {
            if (sequence.current === task) setMessage({ text: '无法读取版本记录。', error: true });
          });
      },
    );
  }
  function confirm() {
    if (!draft || !preview?.token || locked.current) return;
    const request = command ?? {
      epoch: snapshot.epoch,
      token: preview.token,
      requestId: crypto.randomUUID(),
      expectedRevision: preview.expectedRevision,
      reason: reason.trim(),
    };
    setCommand(request);
    void run(
      '确认入库',
      () => api.confirmScores(request),
      (value) => {
        setDraft(undefined);
        setPreview(undefined);
        setFileToken(undefined);
        setPreviewCurrent(false);
        setCommand(undefined);
        setMessage({
          text: `成绩已保存 · 第 ${value.revision} 版${value.replayed ? '（原请求回执）' : ''}`,
          error: false,
        });
        const task = sequence.current;
        void api
          .listExams({ epoch: snapshot.epoch })
          .then((result) => {
            if (sequence.current === task && result.ok) setExams(result.value);
          })
          .catch(() => {
            if (sequence.current === task)
              setMessage({ text: '成绩已保存，考试列表刷新失败，请刷新记录。', error: true });
          });
      },
    );
  }
  const matching = exams.filter((exam) =>
    `${exam.definition.className} ${exam.definition.name}`.includes(examFilter),
  );
  const currentPage = Math.min(examPage, Math.max(0, Math.ceil(matching.length / 15) - 1));
  const expired = preview?.expiresAt ? now >= Date.parse(preview.expiresAt) : true;
  const versionExam = version
    ? exams.find((exam) => exam.examId === version.record.examId)
    : undefined;
  return (
    <div className="score-page">
      <div className="score-actions">
        <button
          type="button"
          className="primary"
          disabled={Boolean(busy) || explanationDirty || !snapshot.classes.length}
          onClick={() =>
            onUnifiedImport
              ? onUnifiedImport()
              : startDraft(
                  newExam(
                    snapshot,
                    snapshot.classes.find((c) => c.id === selectedClass)?.id ??
                      snapshot.classes[0]!.id,
                  ),
                )
          }
        >
          <Plus size={16} />
          新建考试导入
        </button>
        {onUnifiedImport && (
          <button
            disabled={Boolean(busy) || explanationDirty || !snapshot.classes.length}
            onClick={() =>
              startDraft(
                newExam(
                  snapshot,
                  snapshot.classes.find((c) => c.id === selectedClass)?.id ??
                    snapshot.classes[0]!.id,
                ),
              )
            }
          >
            高级考试配置
          </button>
        )}
        <button
          type="button"
          disabled={Boolean(busy) || explanationDirty}
          onClick={() => {
            invalidate();
            setDraft(undefined);
            setPreview(undefined);
            setVersion(undefined);
            void run('刷新记录', () => api.listExams({ epoch: snapshot.epoch }), setExams);
          }}
        >
          <RefreshCw size={16} />
          考试记录
        </button>
        {busy && <span role="status">{busy}</span>}
        {busy === '正在预览' && (
          <button
            type="button"
            onClick={() => {
              sequence.current++;
              locked.current = false;
              setBusy('');
              setPreviewCurrent(false);
              setFileToken(undefined);
              void api.cancelScorePreview({ epoch: snapshot.epoch }).catch(() => {});
              setMessage({ text: '已取消预览，未写入成绩。', error: false });
            }}
          >
            <X size={16} />
            取消预览
          </button>
        )}
      </div>
      {message && (
        <div
          className={`notice ${message.error ? 'error' : 'success'}`}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </div>
      )}
      {!draft && !version && (
        <section className="score-section" aria-label="考试记录">
          <h2>考试记录 · {exams.length} 场</h2>
          <input
            aria-label="搜索考试"
            placeholder="班级 / 考试名称"
            value={examFilter}
            onChange={(event) => {
              setExamFilter(event.target.value);
              setExamPage(0);
            }}
          />
          {!exams.length && <p>暂无考试记录。</p>}
          <div className="score-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>班级</th>
                  <th>考试</th>
                  <th>应考人数</th>
                  <th>版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {matching.slice(currentPage * 15, currentPage * 15 + 15).map((exam) => (
                  <tr key={exam.examId}>
                    <td>{exam.definition.date}</td>
                    <td>{exam.definition.className}</td>
                    <th>{exam.definition.name}</th>
                    <td>{exam.studentCount}</td>
                    <td>{exam.revision}</td>
                    <td>
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => openVersion(exam.versionId)}
                      >
                        查看 {exam.definition.name}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="score-actions">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setExamPage(currentPage - 1)}
            >
              上一页
            </button>
            <span>
              {currentPage + 1} / {Math.max(1, Math.ceil(matching.length / 15))}
            </span>
            <button
              type="button"
              disabled={(currentPage + 1) * 15 >= matching.length}
              onClick={() => setExamPage(currentPage + 1)}
            >
              下一页
            </button>
          </div>
        </section>
      )}
      {draft && (
        <fieldset className="score-editor" disabled={Boolean(busy)}>
          <legend>
            {draft.configuration.examId
              ? `更正考试 · 当前第 ${draft.configuration.expectedRevision} 版`
              : '新考试'}
          </legend>
          <ol className="flow-steps">
            <li className="active">1 考试与科目</li>
            <li className={preview ? 'active' : ''}>2 选择文件与核对</li>
            <li className={preview?.canConfirm ? 'active' : ''}>3 确认入库</li>
          </ol>
          {!draft.configuration.examId && (
            <label>
              应考班级
              <select
                aria-label="应考班级"
                value={draft.configuration.classId}
                onChange={(event) => startDraft(newExam(snapshot, event.target.value))}
              >
                {snapshot.classes.map((classroom) => (
                  <option key={classroom.id} value={classroom.id}>
                    {classroom.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ScoreConfiguration
            draft={draft}
            change={change}
            reportError={(text) => setMessage({ text, error: true })}
          />
          <section className="score-file-setup">
            <h2>3 · 导入成绩文件</h2>
            <p>
              先下载本次考试的模板，填写学生成绩后上传。已有文件也可直接选择；问题会在预览中逐行标出。
            </p>
            <div className="score-actions">
              {(['csv', 'xlsx'] as const).map((format) => (
                <button
                  type="button"
                  key={format}
                  disabled={!draft.roster.length}
                  onClick={() =>
                    void run(
                      '导出模板',
                      () => api.exportScoreTemplate({ ...draft.configuration, format }),
                      (receipt) =>
                        setMessage({
                          text: receipt ? `模板已保存：${receipt.path}` : '已取消导出。',
                          error: false,
                        }),
                    )
                  }
                >
                  <Download size={16} />
                  {format.toUpperCase()} 模板
                </button>
              ))}
              <button
                type="button"
                disabled={!draft.roster.length}
                onClick={() => chooseFile(false)}
              >
                <FileUp size={16} />
                选择成绩文件
              </button>
              <button type="button" disabled={!fileToken} onClick={() => chooseFile(true)}>
                <RefreshCw size={16} />
                重新预览
              </button>
            </div>
            {!draft.roster.length && (
              <div className="empty-roster-guide">
                <p role="alert">该班级没有在籍学生。</p>
                <p>
                  成绩需要与学生名单对应。先在班级名册导入学生，再回来新建考试；当前考试尚未保存。
                </p>
                {onRoster && (
                  <button type="button" className="primary" onClick={onRoster}>
                    先导入学生名单
                  </button>
                )}
              </div>
            )}
          </section>
          {preview && (
            <>
              {!previewCurrent && <p className="score-warning">配置已修改，预览已失效。</p>}
              <ScorePreview
                key={preview.fileHash}
                preview={preview}
                draft={draft}
                change={change}
              />
              {previewCurrent && preview.statistics && (
                <details className="score-section">
                  <summary>查看入库前的成绩统计</summary>
                  <ScoreResults
                    statistics={preview.statistics}
                    subjects={draft.configuration.subjects}
                    groups={draft.configuration.groups}
                    roster={draft.roster}
                    entries={preview.entries}
                  />
                </details>
              )}
              <div className="score-confirm">
                <label>
                  导入 / 更正原因
                  <input
                    aria-label="导入或更正原因"
                    maxLength={300}
                    value={reason}
                    disabled={Boolean(command)}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="primary"
                  disabled={
                    !previewCurrent ||
                    !preview.canConfirm ||
                    !reason.trim() ||
                    (!command && expired)
                  }
                  onClick={confirm}
                >
                  <Save size={16} />
                  {command ? '重试原确认请求' : '确认入库'}
                </button>
                {expired && !command && <span>预览已过期，请重新预览。</span>}
              </div>
            </>
          )}
        </fieldset>
      )}
      {version && (
        <section aria-label="成绩版本">
          <div className="score-actions">
            <h2>
              {version.payload.definition.name} · 第 {version.record.revision} 版
            </h2>
            <select
              aria-label="选择成绩版本"
              value={version.record.id}
              disabled={Boolean(busy) || explanationDirty}
              onChange={(event) => openVersion(event.target.value)}
            >
              {history.map((item) => (
                <option key={item.id} value={item.id}>
                  第 {item.revision} 版 · {item.reason}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={Boolean(busy) || explanationDirty || !versionExam || version.stale}
              onClick={() => {
                if (versionExam)
                  startDraft(correctionDraft(snapshot.epoch, versionExam.classId, version));
              }}
            >
              更正本次考试
            </button>
          </div>
          <p>
            {version.payload.definition.className} · {version.payload.definition.date} ·{' '}
            {version.payload.definition.academicYear} · {version.payload.definition.term} ·{' '}
            {version.record.reason}
          </p>
          <details className="score-section">
            <summary>成绩来源与排除记录</summary>
            {version.payload.publication && (
              <p>
                本版来自完整冻结复核 {version.payload.publication.reviewId}；原成绩父版{' '}
                {version.payload.publication.previousVersionId}
                。在“答卷建议与复核”可核对原图、细则和答卷历史。下方文件记录为沿用的原始导入来源。
              </p>
            )}
            <p>
              {version.payload.source.fileName} · {version.payload.source.kind.toUpperCase()}
            </p>
            <p>文件摘要：{version.payload.source.fileHash}</p>
            <div className="score-bounded-list">
              {version.payload.source.columnMappings.map((mapping) => (
                <p key={mapping.header}>
                  {mapping.header} →{' '}
                  {version.payload.analysis.subjects.find(
                    (subject) => subject.id === mapping.subjectId,
                  )?.name ?? '未知科目'}
                </p>
              ))}
              {version.payload.source.exclusions.length ? (
                version.payload.source.exclusions.map((item) => (
                  <p key={item.row}>
                    第 {item.row} 行：{item.reason}
                  </p>
                ))
              ) : (
                <p>没有排除行。</p>
              )}
            </div>
          </details>
          {version.stale && (
            <div className="score-warning">
              正在查看历史版本，已有更新。
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => openVersion(version.latestVersionId)}
              >
                查看最新版本
              </button>
            </div>
          )}
          <ScoreResults
            key={version.record.id}
            statistics={version.statistics}
            subjects={version.payload.analysis.subjects}
            groups={version.payload.analysis.groups}
            roster={version.payload.analysis.roster}
            entries={version.payload.analysis.entries}
          />
          <ScoreExplanation
            key={`${snapshot.epoch}:${version.record.id}`}
            epoch={snapshot.epoch}
            version={version}
            onDirtyChange={updateExplanationDirty}
            suspended={Boolean(busy) || navigationBusy}
          />
          <section className="score-section" aria-label="学生历次成绩">
            <h2>学生历次成绩</h2>
            <div className="score-actions">
              <select
                aria-label="历史成绩学生"
                disabled={Boolean(busy)}
                value={studentId}
                onChange={(event) => {
                  setStudentId(event.target.value);
                  setStudentHistory(undefined);
                }}
              >
                {version.payload.analysis.roster.map((student) => (
                  <option key={student.studentId} value={student.studentId}>
                    {student.studentNumber} {student.displayName}
                  </option>
                ))}
              </select>
              <select
                aria-label="历史成绩科目"
                disabled={Boolean(busy)}
                value={subjectId}
                onChange={(event) => {
                  setSubjectId(event.target.value);
                  setStudentHistory(undefined);
                }}
              >
                {version.payload.analysis.subjects.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={Boolean(busy) || !studentId || !subjectId}
                onClick={() =>
                  void run(
                    '读取历次成绩',
                    () => api.studentScoreHistory({ epoch: snapshot.epoch, studentId, subjectId }),
                    setStudentHistory,
                  )
                }
              >
                查询历次成绩
              </button>
            </div>
            {studentHistory && (
              <>
                {studentHistory.notes.map((note) => (
                  <p key={note} className="score-warning">
                    {note}
                  </p>
                ))}
                <div className="score-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>日期</th>
                        <th>考试</th>
                        <th>班级</th>
                        <th>成绩</th>
                        <th>满分</th>
                        <th>得分率</th>
                        <th>版本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {studentHistory.entries.map((entry) => (
                        <tr key={entry.versionId}>
                          <td>{entry.date}</td>
                          <td>{entry.examName}</td>
                          <td>{entry.className}</td>
                          <td>{scoreText(entry.score)}</td>
                          <td>{entry.maxScore}</td>
                          <td>{entry.ratePercent === null ? '不适用' : `${entry.ratePercent}%`}</td>
                          <td>{entry.revision}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </section>
      )}
    </div>
  );
}
