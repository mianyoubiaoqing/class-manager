import { useEffect, useRef, useState } from 'react';
import type { Result, Snapshot } from '../shared/contracts';
import type { MaterialPreview, MaterialSummary, StoredMaterial } from '../shared/material-records';
import type {
  LessonReceipt,
  LessonFreezeReceipt,
  LessonDraftSummary,
  LessonDraftView,
  LessonPreparationView,
  LessonVersionView,
  LessonVersionRecord,
} from '../shared/lesson-records';
import type { LessonContent, LessonRequest, MaterialFragment } from '../shared/lessons';
import type { OfficeExportReceipt } from '../shared/office-export';
import { LessonContentEditor } from './LessonContentEditor';
import './lessons.css';
const key = (id: string, fragmentId: number) => `${id}:${fragmentId}`;
const locator = (fragment: MaterialFragment) =>
  fragment.locator.kind === 'lines'
    ? `行 ${fragment.locator.first}–${fragment.locator.last}`
    : fragment.locator.kind === 'page'
      ? `第 ${fragment.locator.index} 页`
      : `第 ${fragment.locator.index} 段`;

export function LessonPage({
  snapshot,
  onDirtyChange,
  navigationBusy,
}: {
  snapshot: Snapshot;
  onDirtyChange: (dirty: boolean) => void;
  navigationBusy: boolean;
}) {
  const api = window.classManager;
  const epoch = snapshot.epoch;
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [preview, setPreview] = useState<MaterialPreview>();
  const [material, setMaterial] = useState<StoredMaterial>();
  const [fragmentId, setFragmentId] = useState(1);
  const [image, setImage] = useState<string>();
  const [imageError, setImageError] = useState('');
  const [selection, setSelection] = useState<LessonRequest['selection']>([]);
  const [request, setRequest] = useState({
    topic: '',
    subject: '物理',
    grade: '高中',
    durationMinutes: 40,
    instructions: '',
    acknowledgePartial: false,
  });
  const [prepared, setPrepared] = useState<LessonPreparationView>();
  const [approved, setApproved] = useState(false);
  const [expired, setExpired] = useState(false);
  const [drafts, setDrafts] = useState<LessonDraftSummary[]>([]);
  const [draft, setDraft] = useState<LessonDraftView>();
  const [version, setVersion] = useState<LessonVersionView>();
  const [history, setHistory] = useState<LessonVersionRecord[]>([]);
  const [content, setContent] = useState<LessonContent>();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState<'freeze' | 'discard'>();
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportAnswers, setExportAnswers] = useState(false);
  const [exportNotes, setExportNotes] = useState(false);
  const [exportReceipt, setExportReceipt] = useState<OfficeExportReceipt>();
  const [message, setMessage] = useState<{ error: boolean; text: string }>();
  const running = useRef(false);
  const alive = useRef(true);
  const modified = Boolean(
    draft &&
    !version &&
    content &&
    JSON.stringify(content) !== JSON.stringify(draft.payload.content),
  );
  const locked = busy || navigationBusy;
  useEffect(() => {
    setExportAnswers(false);
    setExportNotes(false);
    setExportReceipt(undefined);
  }, [version?.record.id]);
  useEffect(() => {
    onDirtyChange(Boolean(preview || prepared || modified || busy || confirming));
  }, [preview, prepared, modified, busy, confirming, onDirtyChange]);
  useEffect(
    () => () => {
      alive.current = false;
      onDirtyChange(false);
    },
    [onDirtyChange],
  );
  async function run<T>(
    operation: () => Promise<Result<T>>,
    accept: (value: T) => void | Promise<void>,
    success?: string,
  ) {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await operation();
      if (!alive.current) return false;
      if (!result.ok) {
        setMessage({
          error: true,
          text: `${result.error.message} (${result.error.code} · ${result.error.operationId})`,
        });
        return false;
      }
      await accept(result.value);
      if (success) setMessage({ error: false, text: success });
      return true;
    } catch {
      if (alive.current)
        setMessage({
          error: true,
          text: '操作中断。请刷新核对保存结果，应用不会自动重试付费请求。',
        });
      return false;
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function refreshLists() {
    const [sources, lessons] = await Promise.all([
      api.listMaterials({ epoch }),
      api.listLessonDrafts({ epoch, includeClosed: true }),
    ]);
    if (!alive.current) return;
    if (sources.ok) setMaterials(sources.value);
    else setMessage({ error: true, text: sources.error.message });
    if (lessons.ok) setDrafts(lessons.value);
    else setMessage({ error: true, text: lessons.error.message });
  }
  useEffect(() => {
    void refreshLists();
  }, []); // This component is keyed by workspace epoch.
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
  const source = preview?.version ?? material?.version;
  const fragment = source?.fragments.find((value) => value.id === fragmentId);
  const pageImage =
    fragment?.kind === 'image'
      ? fragment
      : fragment &&
        source?.fragments.find(
          (value) =>
            value.kind === 'image' &&
            value.locator.kind === fragment.locator.kind &&
            value.locator.kind !== 'lines' &&
            fragment.locator.kind !== 'lines' &&
            value.locator.index === fragment.locator.index,
        );
  useEffect(() => {
    let current = true;
    setImage(undefined);
    setImageError('');
    if (pageImage?.kind === 'image' && source) {
      const operation = preview
        ? api.readMaterialPreviewImage({ epoch, token: preview.token, fragmentId: pageImage.id })
        : api.readMaterialImage({ epoch, id: source.id, fragmentId: pageImage.id });
      void operation
        .then((result) => {
          if (!current) return;
          if (result.ok) setImage(result.value);
          else setImageError(result.error.message);
        })
        .catch(() => {
          if (current) setImageError('资料图像读取中断。');
        });
    }
    return () => {
      current = false;
    };
  }, [source?.id, pageImage?.id, preview?.token, epoch]);
  const openSource = (id: string, nextFragmentId: number) => {
    if (preview) return;
    void run(
      () => api.readMaterial({ epoch, id }),
      (value) => {
        setMaterial(value);
        setFragmentId(nextFragmentId);
      },
    );
  };
  async function loadDraft(id: string) {
    const value = await api.readLessonDraft({ epoch, id });
    if (!value.ok) throw new Error('保存后重读中断，请刷新目录并核对草案。');
    setDraft(value.value);
    setVersion(undefined);
    setContent(value.value.payload.content);
    setReason('');
    setConfirming(undefined);
    const history = await api.lessonHistory({ epoch, id });
    if (history.ok) setHistory(history.value);
    else setHistory([]);
  }
  const openDraft = (id: string) =>
    void run(
      () => api.readLessonDraft({ epoch, id }),
      async (value) => {
        setDraft(value);
        setVersion(undefined);
        setContent(value.payload.content);
        setReason('');
        setConfirming(undefined);
        const result = await api.lessonHistory({ epoch, id });
        setHistory(result.ok ? result.value : []);
      },
    );
  const clearPreparation = () =>
    void run(
      () => api.cancelLesson({ epoch }),
      () => {
        setPrepared(undefined);
        setApproved(false);
      },
      '已取消范围准备。',
    );
  const selectedCount = selection.length;
  async function generate() {
    if (!prepared) return;
    await run(
      () => api.generateLesson({ epoch, token: prepared.token }),
      async (value) => {
        await refreshLists();
        await loadDraft(value.id);
      },
      '备课草案已保存，请逐项复核。',
    );
    setPrepared(undefined);
    setApproved(false);
  }
  async function exportOffice(format: 'docx' | 'pptx') {
    if (!version || running.current) return;
    setExporting(true);
    try {
      await run(
        () =>
          api.exportLessonOffice({
            epoch,
            versionId: version.record.id,
            format,
            includeAnswers: exportAnswers,
            includeTeacherNotes: exportNotes,
          }),
        (value) => {
          setExportReceipt(value ?? undefined);
          setMessage({
            error: false,
            text: value
              ? `已保存 ${value.name}；冻结版本 ${value.revision}。${value.warning ?? '外部编辑不自动回写备课版本。'}`
              : '已取消保存，原文件未改动。',
          });
        },
      );
    } finally {
      if (alive.current) setExporting(false);
    }
  }
  return (
    <div className="lesson-page">
      <p className="lesson-intro">
        导入合成教材，核对可读内容并选择范围，再生成同版教案与课件。草案由教师复核；冻结后通过新草案修订。
      </p>
      {message && (
        <div
          className={`notice ${message.error ? 'error' : 'success'}`}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </div>
      )}
      <section className="lesson-card">
        <header>
          <h2>教学资料</h2>
          <div className="lesson-actions">
            <button
              disabled={locked || Boolean(prepared) || modified}
              onClick={() =>
                void run(
                  () => api.previewMaterial({ epoch }),
                  (value) => {
                    setPreview(value ?? undefined);
                    setFragmentId(value?.version.fragments[0]?.id ?? 1);
                  },
                )
              }
            >
              选择资料文件
            </button>
            <button disabled={locked} onClick={() => void refreshLists()}>
              刷新目录
            </button>
          </div>
        </header>
        <p>
          TXT、DOCX、PDF、PNG、JPG；每份最多 10 MiB，PDF 最多 20
          页。扫描页保留为图像，文字识别结果不冒充教材原文。
        </p>
        <label>
          已保存资料
          <select
            aria-label="已保存资料"
            value={material?.record.id ?? ''}
            disabled={locked || Boolean(preview)}
            onChange={(event) => {
              if (event.target.value) openSource(event.target.value, 1);
            }}
          >
            <option value="">请选择</option>
            {materials.map((value) => (
              <option key={value.record.id} value={value.record.id}>
                {value.record.name} · {value.fragments} 个片段 ·{' '}
                {value.completeness === 'partial' ? '部分解析' : '可读'}
              </option>
            ))}
          </select>
        </label>
        {preview && (
          <div className="lesson-preview-confirm">
            <strong>待保存：{preview.name}</strong>
            <p>这是本地解析预览，尚未发送给模型。核对后保存不可变资料版本。</p>
            <button
              className="primary"
              disabled={locked}
              onClick={() =>
                void run(
                  () =>
                    api.confirmMaterial({
                      epoch,
                      token: preview.token,
                      requestId: crypto.randomUUID(),
                    }),
                  async (value) => {
                    setPreview(undefined);
                    await refreshLists();
                    const result = await api.readMaterial({ epoch, id: value.id });
                    if (result.ok) setMaterial(result.value);
                    else throw new Error('资料已保存，但重读失败。');
                  },
                  '资料版本已保存。',
                )
              }
            >
              确认保存资料
            </button>
            <button
              disabled={navigationBusy}
              onClick={() => {
                void api.cancelMaterial({ epoch }).then((result) => {
                  if (result.ok && !busy) setPreview(undefined);
                });
              }}
            >
              取消资料导入
            </button>
          </div>
        )}
        {busy && !exporting && (
          <button
            type="button"
            onClick={() => {
              void Promise.all([api.cancelMaterial({ epoch }), api.cancelLesson({ epoch })]).then(
                () =>
                  setMessage({ error: false, text: '正在取消。若保存已提交，请以重读记录为准。' }),
              );
            }}
          >
            取消当前解析或生成
          </button>
        )}
        {source && (
          <div className="lesson-source">
            <h3>{preview?.name ?? material?.record.name}</h3>
            <p className="lesson-identity">
              原件 SHA-256：{source.sha256} · {source.bytes} 字节
            </p>
            {source.warnings.map((warning, index) => (
              <p className="lesson-warning" key={index}>
                {warning}
              </p>
            ))}
            {!preview && material && (
              <button
                disabled={locked}
                onClick={() =>
                  void run(
                    () => api.saveMaterialOriginal({ epoch, id: material.record.id }),
                    (value) => {
                      setMessage({
                        error: false,
                        text: value ? `原件副本已保存：${value.path}` : '已取消保存副本。',
                      });
                    },
                  )
                }
              >
                保存原文件副本供对照
              </button>
            )}
            <label>
              对照片段
              <select
                aria-label="对照片段"
                value={fragmentId}
                onChange={(event) => setFragmentId(Number(event.target.value))}
              >
                {source.fragments.map((value) => (
                  <option key={value.id} value={value.id}>
                    #{value.id} · {locator(value)} · {value.kind === 'text' ? '文字' : '原页图像'}
                  </option>
                ))}
              </select>
            </label>
            <div className="lesson-comparison">
              <div>
                <h4>解析内容</h4>
                {fragment?.kind === 'text' ? (
                  <pre>{fragment.text}</pre>
                ) : (
                  <p>当前片段为图像，模型将结合画面内容进行教学设计辅助。</p>
                )}
              </div>
              <div>
                <h4>原页或内嵌图像对照</h4>
                {image ? (
                  <img src={image} alt={`${locator(fragment!)} 原页或内嵌图像`} />
                ) : (
                  <p>
                    {imageError ||
                      (pageImage
                        ? '正在读取图像…'
                        : source.format === 'txt'
                          ? 'TXT 保留原件和行号，仅规范化换行。'
                          : '此片段没有对应图像，可保存原件副本在文档阅读器中对照。')}
                  </p>
                )}
              </div>
            </div>
            {!preview && (
              <fieldset disabled={locked || Boolean(prepared)}>
                <legend>选择允许发送的片段（当前已选 {selectedCount}/80）</legend>
                <div className="lesson-fragment-list">
                  {source.fragments.map((value) => (
                    <label key={value.id}>
                      <input
                        type="checkbox"
                        checked={selection.some(
                          (ref) =>
                            key(ref.sourceVersionId, ref.fragmentId) === key(source.id, value.id),
                        )}
                        onChange={(event) =>
                          setSelection((old) =>
                            event.target.checked
                              ? [...old, { sourceVersionId: source.id, fragmentId: value.id }]
                              : old.filter(
                                  (ref) =>
                                    key(ref.sourceVersionId, ref.fragmentId) !==
                                    key(source.id, value.id),
                                ),
                          )
                        }
                      />
                      <span>
                        #{value.id} · {locator(value)} ·{' '}
                        {value.kind === 'text'
                          ? value.text.slice(0, 100)
                          : `图像 ${value.width}×${value.height}`}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {draft?.record.status === 'draft' &&
              !version &&
              fragment?.kind === 'image' &&
              content &&
              draft.payload.request.selection.some(
                (ref) => ref.sourceVersionId === source.id && ref.fragmentId === fragment.id,
              ) && (
                <button
                  disabled={locked || Boolean(prepared) || Boolean(confirming)}
                  onClick={() =>
                    setContent({
                      ...content,
                      slides: content.slides.map((slide, index) =>
                        index === 0
                          ? {
                              ...slide,
                              content: [
                                ...slide.content,
                                {
                                  kind: 'image',
                                  source: { sourceVersionId: source.id, fragmentId: fragment.id },
                                  caption: '资料图像',
                                },
                              ],
                            }
                          : slide,
                      ),
                    })
                  }
                >
                  插入当前图像到首张课件
                </button>
              )}
          </div>
        )}
      </section>
      <section className="lesson-card">
        <h2>备课范围与要求</h2>
        <fieldset disabled={locked || Boolean(prepared)}>
          <div className="lesson-fields">
            <label>
              课题
              <input
                aria-label="课题"
                value={request.topic}
                maxLength={200}
                onChange={(event) => setRequest({ ...request, topic: event.target.value })}
              />
            </label>
            <label>
              学科
              <input
                value={request.subject}
                maxLength={80}
                onChange={(event) => setRequest({ ...request, subject: event.target.value })}
              />
            </label>
            <label>
              年级
              <input
                value={request.grade}
                maxLength={80}
                onChange={(event) => setRequest({ ...request, grade: event.target.value })}
              />
            </label>
            <label>
              课时（分钟）
              <input
                type="number"
                min={1}
                max={240}
                value={request.durationMinutes}
                onChange={(event) =>
                  setRequest({ ...request, durationMinutes: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <label>
            教学要求
            <textarea
              value={request.instructions}
              maxLength={4000}
              onChange={(event) => setRequest({ ...request, instructions: event.target.value })}
            />
          </label>
          <label className="lesson-checkbox">
            <input
              type="checkbox"
              checked={request.acknowledgePartial}
              onChange={(event) =>
                setRequest({ ...request, acknowledgePartial: event.target.checked })
              }
            />
            我已核对所选内容，确认选用已解析的文字或图像片段。
          </label>
        </fieldset>
        <div className="lesson-selected" aria-label="允许发送的资料片段">
          {selection.map((ref) => (
            <span key={key(ref.sourceVersionId, ref.fragmentId)}>
              {materials.find((value) => value.record.id === ref.sourceVersionId)?.record.name ??
                '资料'}{' '}
              #{ref.fragmentId}
              <button
                aria-label={`移除片段 ${ref.fragmentId}`}
                disabled={locked || Boolean(prepared)}
                onClick={() =>
                  setSelection((old) =>
                    old.filter(
                      (value) =>
                        key(value.sourceVersionId, value.fragmentId) !==
                        key(ref.sourceVersionId, ref.fragmentId),
                    ),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
        {!prepared && (
          <button
            className="primary"
            disabled={
              locked ||
              Boolean(preview) ||
              Boolean(confirming) ||
              modified ||
              !selectedCount ||
              !request.topic.trim()
            }
            onClick={() =>
              void run(
                () => api.prepareLesson({ epoch, request: { ...request, selection } }),
                (value) => {
                  setPrepared(value);
                  setApproved(false);
                },
              )
            }
          >
            准备并核对外发范围
          </button>
        )}
        {prepared && (
          <div className="lesson-model-confirm">
            <h3>确认一次模型生成</h3>
            <p>
              只发送以上 {prepared.sources.length} 份资料中的 {prepared.textCharacters} 个文字字符和{' '}
              {prepared.images} 个图像片段，以及课题和教学要求。图片最长边 2048 像素、JPEG
              副本每张最多 1 MiB；原件、未选内容及本地教师备注不发送。
            </p>
            <p>将使用当前选定的模型基于已选片段生成教案与演示大纲草案。</p>
            <label className="lesson-checkbox">
              <input
                type="checkbox"
                checked={approved}
                disabled={locked}
                onChange={(event) => setApproved(event.target.checked)}
              />
              我确认以上合成资料范围，并同意本次调用产生费用。
            </label>
            {expired && <p className="lesson-warning">范围确认已过期，请取消后重新准备。</p>}
            <div className="lesson-actions">
              <button
                className="primary"
                disabled={locked || modified || !approved || expired}
                onClick={() => void generate()}
              >
                确认付费生成草案
              </button>
              <button disabled={locked} onClick={clearPreparation}>
                取消范围准备
              </button>
            </div>
          </div>
        )}
      </section>
      <section className="lesson-card">
        <h2>备课草案与冻结历史</h2>
        <label>
          已保存草案
          <select
            aria-label="已保存备课草案"
            disabled={locked || modified || Boolean(prepared) || Boolean(confirming)}
            value={draft?.record.id ?? ''}
            onChange={(event) => {
              if (event.target.value) openDraft(event.target.value);
            }}
          >
            <option value="">请选择</option>
            {drafts.map((value) => (
              <option key={value.record.id} value={value.record.id}>
                {value.title} ·{' '}
                {value.record.status === 'draft'
                  ? '草案'
                  : value.record.status === 'frozen'
                    ? '已冻结'
                    : '已丢弃'}{' '}
                · 修订 {value.record.revision}
              </option>
            ))}
          </select>
        </label>
        {draft && (
          <>
            <div className="lesson-history">
              {history.map((value) => (
                <button
                  key={value.id}
                  disabled={locked || modified || Boolean(prepared) || Boolean(confirming)}
                  onClick={() =>
                    void run(
                      () => api.readLessonVersion({ epoch, versionId: value.id }),
                      (saved) => {
                        setVersion(saved);
                        setContent(saved.payload.content);
                      },
                    )
                  }
                >
                  冻结版 {value.revision} · {value.reason}
                </button>
              ))}
              {version && (
                <button
                  disabled={locked || Boolean(prepared) || Boolean(confirming)}
                  onClick={() => {
                    setVersion(undefined);
                    setContent(draft.payload.content);
                  }}
                >
                  返回当前草案
                </button>
              )}
            </div>
            <p>
              {version
                ? `正在查看冻结版 ${version.record.revision}，不可直接修改。`
                : `当前状态：${draft.record.status === 'draft' ? '可编辑草案' : draft.record.status === 'frozen' ? '已冻结' : '已丢弃'} · 修订 ${draft.record.revision}`}
            </p>
            <p>
              {draft.payload.provider ? (
                <>
                  模型来源：{draft.payload.provider.responseModel} · 响应{' '}
                  {draft.payload.provider.responseId} · {draft.payload.provider.generatedAt}
                </>
              ) : (
                '来源：本地编辑 / 对话内容，经确认保存'
              )}
            </p>
            {version && (
              <section className="lesson-office-export" aria-label="冻结版本 Office 导出">
                <h3>导出此冻结版本</h3>
                <p>
                  中文教案与 16:9 课件使用同一冻结版本，不调用模型。答案默认排除；PPTX
                  教师备注仅进入演讲者备注。外部编辑不自动回写。
                </p>
                <fieldset disabled={locked || Boolean(prepared) || Boolean(confirming)}>
                  <label className="lesson-checkbox">
                    <input
                      type="checkbox"
                      checked={exportAnswers}
                      onChange={(event) => setExportAnswers(event.target.checked)}
                    />
                    明确包含参考答案（课件画布将可见）
                  </label>
                  <label className="lesson-checkbox">
                    <input
                      type="checkbox"
                      checked={exportNotes}
                      onChange={(event) => setExportNotes(event.target.checked)}
                    />
                    明确包含教师私有备注（Word 正文／PPTX 演讲者备注）
                  </label>
                  <div className="lesson-actions">
                    <button onClick={() => void exportOffice('docx')}>保存可编辑 Word 教案</button>
                    <button onClick={() => void exportOffice('pptx')}>保存可编辑 PPTX 课件</button>
                  </div>
                </fieldset>
                {exporting && (
                  <button onClick={() => void api.cancelLessonOffice({ epoch })}>
                    取消 Office 导出
                  </button>
                )}
                {exportReceipt && (
                  <p>
                    已保存 {exportReceipt.name} · 冻结版本 {exportReceipt.revision}
                    {exportReceipt.pages ? ` · ${exportReceipt.pages} 页` : ''}{' '}
                    <button
                      disabled={locked || !exportReceipt.openAvailable}
                      onClick={() =>
                        void run(
                          () => api.openLessonOffice({ epoch, token: exportReceipt.token }),
                          () => {},
                          '已请求本机办公软件打开文件。',
                        )
                      }
                    >
                      打开刚保存的文件
                    </button>
                  </p>
                )}
              </section>
            )}
            {content && (
              <fieldset disabled={locked || Boolean(confirming) || Boolean(prepared)}>
                <LessonContentEditor
                  value={content}
                  change={setContent}
                  readOnly={Boolean(version) || draft.record.status !== 'draft'}
                  openSource={openSource}
                />
              </fieldset>
            )}
            {!version && draft.record.status === 'draft' && (
              <div className="lesson-actions">
                <button
                  className="primary"
                  disabled={locked || !modified || Boolean(prepared) || Boolean(confirming)}
                  onClick={() =>
                    void run(
                      () =>
                        api.editLessonDraft({
                          epoch,
                          id: draft.record.id,
                          expectedRevision: draft.record.revision,
                          content: content!,
                        }),
                      async () => {
                        await loadDraft(draft.record.id);
                        await refreshLists();
                      },
                      '教师修改已保存。',
                    )
                  }
                >
                  保存教师修改
                </button>
                <button
                  disabled={locked || !modified || Boolean(prepared) || Boolean(confirming)}
                  onClick={() => setContent(draft.payload.content)}
                >
                  撤销未保存修改
                </button>
                <button
                  disabled={locked || modified || Boolean(prepared) || Boolean(confirming)}
                  onClick={() => {
                    setConfirming('freeze');
                    setReason('');
                  }}
                >
                  冻结备课版本
                </button>
                <button
                  className="danger-button"
                  disabled={locked || modified || Boolean(prepared) || Boolean(confirming)}
                  onClick={() => setConfirming('discard')}
                >
                  丢弃草案
                </button>
              </div>
            )}
            {version && (
              <button
                disabled={locked || Boolean(prepared) || Boolean(confirming)}
                onClick={() =>
                  void run(
                    () =>
                      api.reviseLessonVersion({
                        epoch,
                        versionId: version.record.id,
                        requestId: crypto.randomUUID(),
                      }),
                    async (value) => {
                      await loadDraft(value.id);
                      await refreshLists();
                    },
                    '已创建本地修订草案，不调用模型。',
                  )
                }
              >
                基于此冻结版创建修订草案
              </button>
            )}
            {confirming && (
              <div
                className="lesson-local-confirm"
                role="group"
                aria-label={confirming === 'freeze' ? '确认冻结版本' : '确认丢弃草案'}
              >
                <h3>{confirming === 'freeze' ? '确认冻结同版教案与课件' : '确认丢弃此草案'}</h3>
                <p>
                  {confirming === 'freeze'
                    ? '冻结后不能直接改写，之后创建修订草案形成新版本。'
                    : '丢弃后不能继续编辑；历史记录和模型来源保留。'}
                </p>
                {confirming === 'freeze' && (
                  <label>
                    确认原因
                    <input
                      aria-label="冻结原因"
                      value={reason}
                      maxLength={500}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                )}
                <button
                  className="primary"
                  disabled={locked || modified || (confirming === 'freeze' && !reason.trim())}
                  onClick={() =>
                    void run<LessonReceipt | LessonFreezeReceipt>(
                      () =>
                        confirming === 'freeze'
                          ? api.freezeLessonDraft({
                              epoch,
                              id: draft.record.id,
                              expectedRevision: draft.record.revision,
                              requestId: crypto.randomUUID(),
                              reason,
                            })
                          : api.discardLessonDraft({
                              epoch,
                              id: draft.record.id,
                              expectedRevision: draft.record.revision,
                            }),
                      async () => {
                        setConfirming(undefined);
                        await loadDraft(draft.record.id);
                        await refreshLists();
                      },
                      confirming === 'freeze' ? '备课版本已冻结。' : '草案已丢弃。',
                    )
                  }
                >
                  确认{confirming === 'freeze' ? '冻结' : '丢弃'}
                </button>
                <button disabled={locked} onClick={() => setConfirming(undefined)}>
                  返回核对
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
