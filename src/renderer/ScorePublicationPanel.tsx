import { useEffect, useRef, useState } from 'react';
import type { Result } from '../shared/contracts';
import type { ScorePublicationPreview, ScorePublicationReceipt } from '../shared/score-publication';
import { scoreText } from './score-editor';

/** 教师核对单份冻结复核的正式入分差异；未知回执先查持久事实，全部操作离线且不重新阅卷。 */
export function ScorePublicationPanel({
  epoch,
  reviewId,
  blocked,
  onBusyChange,
  onDirtyChange,
  onPublished,
}: {
  epoch: string;
  reviewId: string;
  blocked: boolean;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onPublished: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<ScorePublicationPreview>();
  const [receipt, setReceipt] = useState<ScorePublicationReceipt | null>(null);
  const [reason, setReason] = useState(''),
    [approved, setApproved] = useState(false),
    [replacement, setReplacement] = useState(false);
  const [message, setMessage] = useState<string>(),
    [busy, setBusy] = useState(false),
    [expired, setExpired] = useState(false);
  const alive = useRef(true),
    running = useRef(false);
  async function run<T>(
    work: () => Promise<Result<T>>,
    accept: (value: T) => void | Promise<void>,
  ) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    setMessage(undefined);
    try {
      const result = await work();
      if (!alive.current) return;
      if (!result.ok) {
        setPreview(undefined);
        setApproved(false);
        setReplacement(false);
        setMessage(`${result.error.message}（${result.error.code} · ${result.error.operationId}）`);
        return;
      }
      await accept(result.value);
    } catch {
      if (alive.current) {
        setPreview(undefined);
        setApproved(false);
        setReplacement(false);
        setMessage('响应中断，请先查询入分结果；原复核保留，无需重新调用模型。');
      }
    } finally {
      running.current = false;
      if (alive.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onDirtyChange(false);
      onBusyChange(false);
    };
  }, [onBusyChange, onDirtyChange]);
  useEffect(() => {
    onDirtyChange(!receipt && Boolean(preview || reason.trim() || busy));
  }, [preview, reason, busy, receipt, onDirtyChange]);
  useEffect(() => {
    const check = () =>
      setExpired(Boolean(preview?.expiresAt && Date.parse(preview.expiresAt) <= Date.now()));
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [preview]);
  return (
    <section className="grading-freeze">
      <h3>复核结果正式入分</h3>
      <p>仅发布当前完整冻结复核。先核对原成绩与新分数，再明确确认；此操作不调用模型。</p>
      <button
        disabled={blocked || busy}
        onClick={() =>
          void run(
            () => window.classManager.readScorePublication({ epoch, reviewId }),
            async (value) => {
              setReceipt(value);
              setPreview(undefined);
              setApproved(false);
              setReplacement(false);
              setMessage(
                value
                  ? '已查到正式入分记录，重复操作不会再次改分。'
                  : '未查到已提交记录；可重新准备入分差异。',
              );
              if (value) await onPublished();
            },
          )
        }
      >
        查询入分结果
      </button>
      {!receipt && (
        <button
          disabled={blocked || busy}
          onClick={() =>
            void run(
              () => window.classManager.prepareScorePublication({ epoch, reviewId }),
              (value) => {
                setPreview(value);
                setReceipt(value.receipt);
                setApproved(false);
                setReplacement(false);
              },
            )
          }
        >
          准备正式入分差异
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {receipt ? (
        <p className="notice success">
          已正式入分 · 成绩修订 {receipt.revision} · 复核 {receipt.reviewId} · 新成绩版本{' '}
          {receipt.versionId}。可到“成绩管理”读取新统计；来源和历史保持可追溯。
        </p>
      ) : (
        preview && (
          <>
            <p>
              学生 {preview.studentId} · 科目 {preview.subjectId} · 考试 {preview.examId} · 原成绩：
              {scoreText(preview.before)} → 新成绩：{scoreText(preview.after)}
              。只更新本学生、本科目。
            </p>
            <details>
              <summary>核对入分依据</summary>
              <p>
                复核 {preview.reviewId} · 答卷 {preview.draftId} / 修订 {preview.draftRevision} ·
                细则 {preview.rubricVersionId} · 原成绩版本 {preview.expectedVersionId}
              </p>
            </details>
            <label>
              入分说明
              <input
                disabled={blocked || busy}
                maxLength={300}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setApproved(false);
                  setReplacement(false);
                }}
              />
            </label>
            {preview.replacesExisting && (
              <label>
                <input
                  type="checkbox"
                  disabled={blocked || busy}
                  checked={replacement}
                  onChange={(e) => setReplacement(e.target.checked)}
                />
                已核对原成绩差异，明确同意替换本学生本科目成绩
              </label>
            )}
            <label>
              <input
                type="checkbox"
                disabled={blocked || busy}
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
              />
              已核对冻结复核和入分范围，同意正式写入成绩
            </label>
            {expired && <p className="notice warning">入分预览已过期，请重新准备并核对。</p>}
            <button
              disabled={
                blocked ||
                busy ||
                expired ||
                !preview.token ||
                !reason.trim() ||
                !approved ||
                (preview.replacesExisting && !replacement)
              }
              onClick={() =>
                void run(
                  () =>
                    window.classManager.confirmScorePublication({
                      epoch,
                      reviewId,
                      token: preview.token!,
                      expectedVersionId: preview.expectedVersionId,
                      reason,
                      acknowledgePublish: true,
                      acknowledgeReplacement: replacement,
                    }),
                  async (value) => {
                    setReceipt(value);
                    setPreview(undefined);
                    setReason('');
                    setApproved(false);
                    setReplacement(false);
                    await onPublished();
                  },
                )
              }
            >
              确认正式入分
            </button>
            <button
              disabled={blocked || busy}
              onClick={() => {
                setPreview(undefined);
                setApproved(false);
                setReplacement(false);
                setReason('');
              }}
            >
              关闭入分预览
            </button>
          </>
        )
      )}
    </section>
  );
}
