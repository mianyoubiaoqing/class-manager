import { useEffect, useRef, useState } from 'react';
import { MonitorPlay, X } from 'lucide-react';
import { ActivityTimer } from './ActivityTimer';
import type { z } from 'zod';
import type { Result, Snapshot } from '../shared/contracts';
import type {
  LessonDraftSummary,
  LessonVersionRecord,
  LessonVersionView,
} from '../shared/lesson-records';
import type { LessonBlock } from '../shared/lessons';
import type {
  classroomControlInput,
  ClassroomCatalog,
  ClassroomTeacherView,
  ClassroomClock,
  CountdownView,
} from '../shared/classroom';
import './classroom-control.css';

const prompt = (block: LessonBlock) =>
  block.kind === 'paragraph'
    ? block.text
    : block.kind === 'list'
      ? block.items.join('\n')
      : block.kind === 'table'
        ? [block.columns.join(' | '), ...block.rows.map((row) => row.join(' | '))].join('\n')
        : block.caption;

function SlideImage({
  epoch,
  block,
}: {
  epoch: string;
  block: Extract<LessonBlock, { kind: 'image' }>;
}) {
  const [image, setImage] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setImage('');
    setError('');
    void window.classManager
      .readMaterialImage({
        epoch,
        id: block.source.sourceVersionId,
        fragmentId: block.source.fragmentId,
      })
      .then((result) => {
        if (!active) return;
        if (result.ok) setImage(result.value);
        else setError(result.error.message);
      })
      .catch(() => {
        if (active) setError('图片读取失败，请重新选择此页。');
      });
    return () => {
      active = false;
    };
  }, [epoch, block.source.sourceVersionId, block.source.fragmentId]);
  return (
    <figure>
      {image ? (
        <img src={image} alt={block.caption} />
      ) : (
        <p role="status">{error || '正在读取课件图片…'}</p>
      )}
      <figcaption>{block.caption}</figcaption>
    </figure>
  );
}
export function ClassroomPage({
  snapshot,
  navigationBusy,
  onDirtyChange,
}: {
  snapshot: Snapshot;
  navigationBusy: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const api = window.classManager,
    epoch = snapshot.epoch;
  const [lessons, setLessons] = useState<LessonDraftSummary[]>([]);
  const [draftId, setDraftId] = useState('');
  const [history, setHistory] = useState<LessonVersionRecord[]>([]);
  const [version, setVersion] = useState<LessonVersionView>();
  const [classId, setClassId] = useState(snapshot.classes[0]?.id ?? '');
  const [slideIds, setSlideIds] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  const [catalog, setCatalog] = useState<ClassroomCatalog>({ items: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [session, setSession] = useState<ClassroomTeacherView>();
  const [sessionVersion, setSessionVersion] = useState<LessonVersionView>();
  const [clock, setClock] = useState<ClassroomClock>();
  const [countdown, setCountdown] = useState<CountdownView | null>(null);
  const [setting, setSetting] = useState({
    name: '高考倒计时',
    targetDate: '',
    timeZone: 'Asia/Shanghai',
  });
  const [countdownDirty, setCountdownDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [countdownReady, setCountdownReady] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [choosing, setChoosing] = useState(false),
    [timerRunning, setTimerRunning] = useState(false);
  const setupDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (choosing) setupDialog.current?.showModal();
    else setupDialog.current?.close();
  }, [choosing]);
  const alive = useRef(true),
    running = useRef(false);
  const locked = busy || navigationBusy || initializing;
  useEffect(() => {
    onDirtyChange(busy || countdownDirty || timerRunning);
  }, [busy, countdownDirty, timerRunning, onDirtyChange]);
  useEffect(
    () => () => {
      alive.current = false;
      onDirtyChange(false);
    },
    [onDirtyChange],
  );
  async function run<T>(
    operation: () => Promise<Result<T>>,
    accept: (value: T) => void | boolean | Promise<void | boolean>,
    text?: string,
  ) {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await operation();
      if (!alive.current) return false;
      if (!result.ok) {
        setNotice({ text: `${result.error.message} (${result.error.code})`, error: true });
        return false;
      }
      const accepted = await accept(result.value);
      if (accepted === false) return false;
      if (text && alive.current) setNotice({ text, error: false });
      return true;
    } catch {
      if (alive.current)
        setNotice({ text: '操作中断，请重新读取已保存进度后再操作。', error: true });
      return false;
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function refreshCatalog(nextOffset = offset) {
    const result = await api.listClassrooms({ epoch, offset: nextOffset, limit: 50 });
    if (!alive.current) return;
    if (result.ok) {
      setCatalog(result.value);
      setOffset(nextOffset);
    } else setNotice({ text: result.error.message, error: true });
  }
  useEffect(() => {
    void (async () => {
      try {
        const [drafts, saved, date] = await Promise.all([
          api.listLessonDrafts({ epoch, includeClosed: true }),
          api.listClassrooms({ epoch }),
          api.readCountdown({ epoch }),
        ]);
        if (!alive.current) return;
        if (drafts.ok)
          setLessons([
            ...new Map(drafts.value.map((value) => [value.record.lessonId, value])).values(),
          ]);
        if (saved.ok) setCatalog(saved.value);
        if (date.ok) {
          setCountdown(date.value);
          setCountdownReady(true);
          if (date.value) setSetting(date.value.setting);
        }
        const failed = [drafts, saved, date].find((value) => !value.ok);
        if (failed && !failed.ok) setNotice({ text: failed.error.message, error: true });
      } catch {
        if (alive.current)
          setNotice({ text: '初始数据读取失败，请重新读取目录和倒计时设置。', error: true });
      } finally {
        if (alive.current) setInitializing(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (!session) {
      setClock(undefined);
      return;
    }
    let current = true,
      pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api.readClassroomClock({ epoch, id: session.record.id });
        if (!current || !alive.current) return;
        if (result.ok) setClock(result.value);
        else setNotice({ text: result.error.message, error: true });
      } catch {
        if (current && alive.current)
          setNotice({ text: '课堂计时读取失败，请重新读取已保存进度。', error: true });
      } finally {
        pending = false;
      }
    };
    void read();
    const interval = setInterval(() => void read(), 1000);
    return () => {
      current = false;
      clearInterval(interval);
    };
  }, [session?.record.id]);
  async function acceptSession(value: ClassroomTeacherView) {
    setSession(value);
    setChoosing(false);
    setClock(undefined);
    const result = await api.readLessonVersion({ epoch, versionId: value.record.versionId });
    if (alive.current) {
      if (result.ok) setSessionVersion(result.value);
      else {
        setSessionVersion(undefined);
        setNotice({ text: result.error.message, error: true });
        return false;
      }
    }
  }
  async function control(
    action: z.infer<typeof classroomControlInput>['action'],
    extra: { visible?: boolean; slideId?: string } = {},
  ) {
    if (!session) return;
    await run(
      () =>
        api.controlClassroom({
          epoch,
          id: session.record.id,
          expectedRevision: session.record.revision,
          action,
          ...extra,
        }),
      acceptSession,
      '课堂进度已保存。',
    );
    await refreshCatalog();
  }
  const elapsed = Math.floor((clock?.elapsedMs ?? session?.record.elapsedMs ?? 0) / 1000);
  const currentSlide = session?.slides[session.record.payload.index];
  const questions =
    sessionVersion?.payload.content.sections.find((value) => value.id === currentSlide?.sectionId)
      ?.questions ?? [];
  const ended = session?.record.status === 'ended';
  return (
    <div className="classroom-control">
      {notice && (
        <p
          className={`notice ${notice.error ? 'error' : 'success'}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}
      <dialog
        ref={setupDialog}
        className="classroom-setup-dialog"
        aria-label="确认课堂版本与范围"
        onCancel={(event) => {
          event.preventDefault();
          if (!locked) setChoosing(false);
        }}
      >
        <header className="dialog-header">
          <h2>选择课件与授课班级</h2>
          <button
            className="icon-button"
            aria-label="关闭课件选择"
            disabled={locked}
            onClick={() => setChoosing(false)}
          >
            <X size={20} />
          </button>
        </header>
        <h2>开始一堂课堂</h2>
        <p>
          先确认班级、冻结版本与课件范围。已有课堂不会跟随备课草稿或新冻结版自动变化；展示窗口不接收私有备注、名册、成绩或档案。
        </p>
        <div className="classroom-form-grid">
          <label>
            授课班级
            <select
              aria-label="授课班级"
              value={classId}
              disabled={locked}
              onChange={(event) => {
                setClassId(event.target.value);
                setApproved(false);
              }}
            >
              <option value="">请选择班级</option>
              {snapshot.classes.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            备课主题
            <select
              aria-label="备课主题"
              value={draftId}
              disabled={locked}
              onChange={(event) => {
                const id = event.target.value;
                setDraftId(id);
                setVersion(undefined);
                setSlideIds([]);
                setApproved(false);
                setHistory([]);
                if (id) void run(() => api.lessonHistory({ epoch, id }), setHistory);
              }}
            >
              <option value="">请选择已保存备课</option>
              {lessons.map((value) => (
                <option key={value.record.id} value={value.record.id}>
                  {value.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            具体冻结版本
            <select
              aria-label="具体冻结版本"
              value={version?.record.id ?? ''}
              disabled={locked || !history.length}
              onChange={(event) => {
                const versionId = event.target.value;
                setVersion(undefined);
                setSlideIds([]);
                setApproved(false);
                if (versionId)
                  void run(
                    () => api.readLessonVersion({ epoch, versionId }),
                    (value) => {
                      setVersion(value);
                      setSlideIds(value.payload.content.slides.map((slide) => slide.id));
                    },
                  );
              }}
            >
              <option value="">请选择确切版本</option>
              {history.map((value) => (
                <option key={value.id} value={value.id}>
                  冻结版 {value.revision} · {value.reason}
                </option>
              ))}
            </select>
          </label>
        </div>
        {version && (
          <fieldset disabled={locked}>
            <legend>允许展示的课件页（保持原顺序）</legend>
            {version.payload.content.slides.map((slide, index) => (
              <label key={slide.id} className="classroom-check">
                <input
                  type="checkbox"
                  checked={slideIds.includes(slide.id)}
                  onChange={(event) => {
                    const selected = new Set(slideIds);
                    if (event.target.checked) selected.add(slide.id);
                    else selected.delete(slide.id);
                    setSlideIds(
                      version.payload.content.slides
                        .filter((value) => selected.has(value.id))
                        .map((value) => value.id),
                    );
                    setApproved(false);
                  }}
                />
                {index + 1}. {slide.title}
              </label>
            ))}
          </fieldset>
        )}
        <label className="classroom-check">
          <input
            type="checkbox"
            disabled={locked || !version || !slideIds.length || !classId}
            checked={approved}
            onChange={(event) => setApproved(event.target.checked)}
          />
          我已核对班级、冻结版和所选范围，开始时不展示答案
        </label>
        <button
          className="primary"
          disabled={locked || !approved || !version}
          onClick={() =>
            void run(
              () =>
                api.createClassroom({
                  epoch,
                  requestId: crypto.randomUUID(),
                  versionId: version!.record.id,
                  classId,
                  slideIds,
                  acknowledgeScope: true,
                }),
              async (value) => {
                const accepted = await acceptSession(value);
                await refreshCatalog();
                return accepted;
              },
              '课堂已创建，进度为暂停状态。',
            )
          }
        >
          确认此版范围并创建课堂
        </button>
        {!snapshot.classes.length && <p>请先在名册创建授课班级。</p>}
      </dialog>
      <section className="classroom-preview-panel" aria-label="课堂进度与控制">
        <header className="flow-panel-heading">
          <div>
            <h2>课堂展示预览</h2>
            <p>选择已确认的课件，在大屏上展示。</p>
          </div>
          <button disabled={locked} onClick={() => setChoosing(true)}>
            选择课件
          </button>
        </header>
        <details className="classroom-catalog">
          <summary>继续已保存课堂</summary>
          <label>
            课堂进度
            <select
              aria-label="课堂进度"
              value={session?.record.id ?? ''}
              disabled={locked}
              onChange={(event) => {
                const id = event.target.value;
                setSession(undefined);
                setSessionVersion(undefined);
                if (id) void run(() => api.readClassroom({ epoch, id }), acceptSession);
              }}
            >
              <option value="">请选择保存的课堂</option>
              {catalog.items.map((value) => (
                <option key={value.record.id} value={value.record.id}>
                  {value.className} · {value.title} · 冻结版 {value.versionRevision} ·{' '}
                  {value.record.createdAt}
                </option>
              ))}
            </select>
          </label>
          <div className="classroom-actions">
            <button
              disabled={locked || offset === 0}
              onClick={() => void refreshCatalog(Math.max(0, offset - 50))}
            >
              上一批课堂
            </button>
            <span>{catalog.total} 条进度</span>
            <button
              disabled={locked || offset + 50 >= catalog.total}
              onClick={() => void refreshCatalog(offset + 50)}
            >
              下一批课堂
            </button>
            <button disabled={locked} onClick={() => void refreshCatalog()}>
              重新读取课堂目录
            </button>
          </div>
        </details>
        {!session && (
          <div className="workspace-empty-guide classroom-empty-preview">
            <MonitorPlay size={40} />
            <h3>尚未选择课件</h3>
            <p>先从本地备课中生成并确认课件。</p>
            <button className="primary" disabled={locked} onClick={() => setChoosing(true)}>
              选择课件并开始课堂
            </button>
          </div>
        )}
        {session && (
          <>
            <div className="classroom-slide-preview">
              <small>{currentSlide?.sectionTitle}</small>
              <h3>{currentSlide?.title}</h3>
              {sessionVersion?.payload.content.slides
                .find((slide) => slide.id === currentSlide?.id)
                ?.content.map((block, index) =>
                  block.kind === 'image' ? (
                    <SlideImage key={index} epoch={epoch} block={block} />
                  ) : block.kind === 'list' ? (
                    <ul key={index}>
                      {block.items.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  ) : block.kind === 'table' ? (
                    <div className="table-scroll" key={index}>
                      <table>
                        <thead>
                          <tr>
                            {block.columns.map((column, i) => (
                              <th key={i}>{column}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {block.rows.map((row, i) => (
                            <tr key={i}>
                              {row.map((cell, j) => (
                                <td key={j}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p key={index}>{block.text}</p>
                  ),
                )}
            </div>
            <p>
              当前：{session.className} · {session.title} · 冻结版 {session.versionRevision} · 第{' '}
              {session.record.payload.index + 1}/{session.slides.length} 页
            </p>
            <p>
              环节：{currentSlide?.sectionTitle} · 建议 {currentSlide?.durationMinutes} 分钟 · 计时{' '}
              {Math.floor(elapsed / 60)
                .toString()
                .padStart(2, '0')}
              :{(elapsed % 60).toString().padStart(2, '0')} ·{' '}
              {(clock?.status ?? session.record.status) === 'running'
                ? '计时中'
                : ended
                  ? '已结束'
                  : '暂停'}
            </p>
            {session.record.interrupted && (
              <p role="status">
                上次计时未正常结束，已恢复到保存的进度并保持暂停；离线期间不累加。
              </p>
            )}
            {clock?.checkpointFailed && (
              <p role="alert">进度自动保存失败，请保存并暂停，检查磁盘空间和权限。</p>
            )}
            <label>
              课堂课件页
              <select
                aria-label="课堂课件页"
                disabled={locked || ended}
                value={currentSlide?.id ?? ''}
                onChange={(event) => void control('slide', { slideId: event.target.value })}
              >
                {session.slides.map((slide, index) => (
                  <option key={slide.id} value={slide.id}>
                    {index + 1}. {slide.sectionTitle} · {slide.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="classroom-actions">
              <button
                disabled={locked || ended || session.record.payload.index === 0}
                onClick={() => void control('previous')}
              >
                上一页
              </button>
              <button
                disabled={
                  locked || ended || session.record.payload.index === session.slides.length - 1
                }
                onClick={() => void control('next')}
              >
                下一页
              </button>
              <button
                disabled={locked || ended || session.record.status === 'running'}
                onClick={() => void control('resume')}
              >
                开始或恢复计时
              </button>
              <button disabled={locked || ended} onClick={() => void control('pause')}>
                保存进度并暂停
              </button>
              <button disabled={locked || ended} onClick={() => void control('reset')}>
                重置当前环节计时
              </button>
            </div>
            <div className="classroom-actions">
              <button
                disabled={locked || ended}
                onClick={() =>
                  void run(
                    () => api.openClassroomDisplay({ epoch, id: session.record.id }),
                    async () => {
                      const result = await api.readClassroom({ epoch, id: session.record.id });
                      if (result.ok) return acceptSession(result.value);
                      setSession(undefined);
                      setSessionVersion(undefined);
                      setNotice({
                        text: `展示已打开，但进度回读失败；请重新选择课堂读取后再控制。${result.error.message}`,
                        error: true,
                      });
                      return false;
                    },
                    '已打开独立课堂展示，答案默认隐藏。',
                  )
                }
              >
                打开全屏课堂展示
              </button>
              <button
                disabled={locked}
                onClick={() =>
                  void run(
                    () => api.closeClassroomDisplay({ epoch }),
                    () => {},
                    '展示已关闭；计时按当前状态继续，可保存并暂停。',
                  )
                }
              >
                关闭课堂展示
              </button>
              <button disabled={locked || ended} onClick={() => void control('finish')}>
                保存并结束课堂
              </button>
            </div>
            <label className="classroom-check">
              <input
                type="checkbox"
                disabled={locked || ended}
                checked={session.record.payload.questionsVisible}
                onChange={(event) => void control('questions', { visible: event.target.checked })}
              />
              明确在展示窗口显示当前环节问题
            </label>
            <label className="classroom-check">
              <input
                type="checkbox"
                disabled={locked || ended}
                checked={session.record.payload.answersVisible}
                onChange={(event) => void control('answers', { visible: event.target.checked })}
              />
              明确在展示窗口显示当前页参考答案
            </label>
            <details>
              <summary>教师提问提示（仅此控制页）</summary>
              {questions.length ? (
                questions.map((block, index) => <p key={index}>{prompt(block)}</p>)
              ) : (
                <p>本环节没有保存的提问提示。</p>
              )}
            </details>
            <p>
              换页会隐藏问题与答案；换环节会暂停并重置环节计时。离开或退出前保存并暂停。异常退出恢复最近保存的进度；计时进度不代表学生掌握情况。
            </p>
          </>
        )}
      </section>
      <ActivityTimer onRunningChange={setTimerRunning} />
      <section className="exam-countdown-panel" aria-label="高考倒计时设置">
        <h2>高考倒计时</h2>
        <p>
          名称、目标日期及时区由教师设置，不自动猜测当地考试安排。按目标时区的日历日期计算，首页及课堂显示。
        </p>
        {countdown && (
          <p>
            {countdown.setting.name}：
            {countdown.status === 'future'
              ? `剩余 ${countdown.remainingDays} 天`
              : countdown.status === 'today'
                ? '目标日期已到'
                : '目标日期已过'}{' '}
            · {countdown.setting.targetDate} · {countdown.setting.timeZone}
          </p>
        )}
        <details open={countdownDirty}>
          <summary>设置考试日期与名称</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  api.setCountdown({ epoch, expectedRevision: countdown?.revision ?? 0, setting }),
                (value) => {
                  setCountdown(value);
                  setSetting(value.setting);
                  setCountdownDirty(false);
                },
                '倒计时已保存。',
              );
            }}
          >
            <div className="classroom-form-grid">
              <label>
                倒计时名称
                <input
                  value={setting.name}
                  maxLength={80}
                  disabled={locked}
                  onChange={(event) => {
                    setSetting({ ...setting, name: event.target.value });
                    setCountdownDirty(true);
                  }}
                  required
                />
              </label>
              <label>
                目标日期
                <input
                  type="date"
                  value={setting.targetDate}
                  disabled={locked}
                  onChange={(event) => {
                    setSetting({ ...setting, targetDate: event.target.value });
                    setCountdownDirty(true);
                  }}
                  required
                />
              </label>
              <label>
                目标时区
                <input
                  value={setting.timeZone}
                  maxLength={80}
                  list="classroom-timezones"
                  disabled={locked}
                  onChange={(event) => {
                    setSetting({ ...setting, timeZone: event.target.value });
                    setCountdownDirty(true);
                  }}
                  required
                />
                <datalist id="classroom-timezones">
                  <option value="Asia/Shanghai" />
                  <option value="UTC" />
                  <option value="America/New_York" />
                  <option value="Europe/London" />
                </datalist>
              </label>
            </div>
            <div className="classroom-actions">
              <button className="primary" disabled={locked || !countdownReady}>
                保存倒计时
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() =>
                  void run(
                    () => api.readCountdown({ epoch }),
                    (value) => {
                      setCountdown(value);
                      setCountdownReady(true);
                      setSetting(
                        value?.setting ?? {
                          name: '高考倒计时',
                          targetDate: '',
                          timeZone: 'Asia/Shanghai',
                        },
                      );
                      setCountdownDirty(false);
                    },
                  )
                }
              >
                放弃修改并重新读取倒计时
              </button>
            </div>
          </form>
        </details>
      </section>
    </div>
  );
}
