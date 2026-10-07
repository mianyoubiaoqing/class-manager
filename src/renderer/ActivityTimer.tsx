import { useEffect, useRef, useState } from 'react';

export function ActivityTimer({
  onRunningChange,
}: {
  onRunningChange: (running: boolean) => void;
}) {
  const [minutes, setMinutes] = useState('5'),
    [seconds, setSeconds] = useState(300),
    [running, setRunning] = useState(false),
    [finished, setFinished] = useState(false);
  const deadline = useRef(0),
    audio = useRef<AudioContext | undefined>(undefined);
  const duration = Number(minutes),
    valid = Number.isFinite(duration) && duration >= 1 && duration <= 240;
  useEffect(() => {
    onRunningChange(running);
    return () => onRunningChange(false);
  }, [running, onRunningChange]);
  useEffect(
    () => () => {
      void audio.current?.close().catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline.current - performance.now()) / 1000));
      setSeconds(remaining);
      if (!remaining) {
        setRunning(false);
        setFinished(true);
        try {
          const context = audio.current;
          if (context && context.state === 'running') {
            const oscillator = context.createOscillator(),
              gain = context.createGain();
            oscillator.connect(gain);
            gain.connect(context.destination);
            gain.gain.setValueAtTime(0.1, context.currentTime);
            oscillator.frequency.setValueAtTime(880, context.currentTime);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.45);
          }
        } catch {
          /* Visual completion remains available without audio. */
        }
      }
    };
    tick();
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  }, [running]);
  function choose(value: string) {
    setMinutes(value);
    setSeconds(Math.round(Number(value) * 60));
    setFinished(false);
  }
  return (
    <section className="activity-timer" aria-label="课堂活动倒计时">
      <h2>课堂倒计时</h2>
      <p>适合讨论、练习和限时展示。</p>
      <output className="timer-digits" aria-label="倒计时剩余时间">
        {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
      </output>
      <div className="button-row">
        {['5', '10'].map((value) => (
          <button key={value} disabled={running} onClick={() => choose(value)}>
            {value} 分钟
          </button>
        ))}
      </div>
      <label>
        自定义时长（分钟）
        <input
          aria-label="活动倒计时分钟"
          type="number"
          min={1}
          max={240}
          value={minutes}
          disabled={running}
          onChange={(e) => {
            setMinutes(e.target.value);
            if (Number(e.target.value) >= 1 && Number(e.target.value) <= 240)
              setSeconds(Math.round(Number(e.target.value) * 60));
            setFinished(false);
          }}
        />
      </label>
      <button
        className="primary"
        disabled={!valid}
        onClick={() => {
          if (running) {
            setSeconds(Math.max(0, Math.ceil((deadline.current - performance.now()) / 1000)));
            setRunning(false);
          } else {
            if (!seconds) setSeconds(Math.round(duration * 60));
            deadline.current = performance.now() + (seconds || Math.round(duration * 60)) * 1000;
            setFinished(false);
            setRunning(true);
            try {
              audio.current ??= new AudioContext();
              void audio.current.resume().catch(() => {});
            } catch {
              /* Audio may be unavailable. */
            }
          }
        }}
      >
        {running
          ? '暂停倒计时'
          : finished
            ? '再次开始'
            : seconds === Math.round(duration * 60)
              ? '开始计时'
              : '继续倒计时'}
      </button>
      <button disabled={running || !valid} onClick={() => choose(minutes)}>
        重置倒计时
      </button>
      {finished && (
        <p role="status" className="notice success">
          时间到了，请结束当前活动。
        </p>
      )}
      <small>到时提醒：界面提示与声音。仅在此控制页运行，离开前请暂停。</small>
    </section>
  );
}
