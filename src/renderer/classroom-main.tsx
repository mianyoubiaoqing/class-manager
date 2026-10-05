import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import type { ClassroomDisplayApi } from '../shared/classroom-display';
import type { ClassroomBlock, ClassroomClock, ClassroomProjection } from '../shared/classroom';
import './classroom.css';
declare global {
  interface Window {
    classroomDisplay: ClassroomDisplayApi;
  }
}
function Block({ value }: { value: ClassroomBlock }) {
  switch (value.kind) {
    case 'paragraph':
      return <p>{value.text}</p>;
    case 'list':
      return (
        <ul>
          {value.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="display-table">
          <table>
            <thead>
              <tr>
                {value.columns.map((label, index) => (
                  <th key={index}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, index) => (
                    <td key={index}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'image':
      return (
        <figure>
          <img src={value.dataUrl} alt={value.caption} />
          <figcaption>{value.caption}</figcaption>
        </figure>
      );
  }
}
function Display() {
  const [view, setView] = useState<ClassroomProjection>();
  const [clock, setClock] = useState<ClassroomClock>();
  const [error, setError] = useState('');
  const revision = useRef<number | undefined>(undefined);
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    let alive = true,
      pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const api = window.classroomDisplay;
        if (!api) throw new Error('展示接口不可用，请由教师控制页重新打开。');
        const [projection, timer] = await Promise.all([
          api.readProjection({ knownRevision: revision.current }),
          api.readClock(),
        ]);
        if (!alive) return;
        if (!projection.ok) throw new Error(projection.error.message);
        if (!timer.ok) throw new Error(timer.error.message);
        if (projection.value.view) {
          setView(projection.value.view);
          revision.current = projection.value.revision;
          content.current?.scrollTo({ top: 0 });
        }
        setClock(timer.value);
        setError('');
      } catch (error) {
        if (alive) {
          setError(error instanceof Error ? error.message : '展示读取失败');
          setView(undefined);
          setClock(undefined);
          revision.current = undefined;
        }
      } finally {
        pending = false;
      }
    };
    void read();
    const interval = setInterval(() => void read(), 1000);
    const resume = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      alive = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  const elapsed = Math.floor((clock?.elapsedMs ?? view?.elapsedMs ?? 0) / 1000);
  const countdown = clock?.countdown ?? view?.countdown;
  return (
    <div className="classroom-display">
      <header>
        <span>{view ? `课堂展示 · 冻结版 ${view.versionRevision}` : '课堂展示'}</span>
        <div>
          <button onClick={() => void window.classroomDisplay.setFullscreen({ fullscreen: true })}>
            全屏
          </button>
          <button onClick={() => void window.classroomDisplay.setFullscreen({ fullscreen: false })}>
            退出全屏
          </button>
        </div>
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : view ? (
        <>
          <main ref={content} aria-label="当前课堂内容">
            <div className="display-heading">
              <p>{view.title}</p>
              <p>
                {view.sectionTitle} · 建议 {view.durationMinutes} 分钟
              </p>
              <h1>{view.slideTitle}</h1>
            </div>
            {view.content.map((value, index) => (
              <Block key={index} value={value} />
            ))}
            {view.questions.length > 0 && (
              <section aria-label="教师选择展示的问题">
                <h2>提问</h2>
                {view.questions.map((value, index) => (
                  <Block key={index} value={value} />
                ))}
              </section>
            )}
            {view.answers.length > 0 && (
              <section aria-label="教师选择展示的答案">
                <h2>参考答案</h2>
                {view.answers.map((value, index) => (
                  <Block key={index} value={value} />
                ))}
              </section>
            )}
          </main>
          <footer>
            <span>
              第 {view.position} / {view.total} 页 · 内容较长时可滚动查看
            </span>
            <span>
              环节计时{' '}
              {Math.floor(elapsed / 60)
                .toString()
                .padStart(2, '0')}
              :{(elapsed % 60).toString().padStart(2, '0')} ·{' '}
              {(clock?.status ?? view.status) === 'running'
                ? '计时中'
                : (clock?.status ?? view.status) === 'ended'
                  ? '已结束'
                  : '暂停'}
            </span>
            {countdown && (
              <span>
                {countdown.setting.name}：
                {countdown.status === 'future'
                  ? `剩余 ${countdown.remainingDays} 天`
                  : countdown.status === 'today'
                    ? '目标日期已到'
                    : '目标日期已过'}{' '}
                · {countdown.setting.timeZone}
              </span>
            )}
          </footer>
        </>
      ) : (
        <p role="status">正在读取教师确认的课堂内容…</p>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Display />);
