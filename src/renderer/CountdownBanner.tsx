import { useEffect, useState } from 'react';
import type { CountdownView } from '../shared/classroom';
import './classroom-control.css';
export function CountdownBanner({ epoch }: { epoch: string }) {
  const [value, setValue] = useState<CountdownView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true,
      pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await window.classManager.readCountdown({ epoch });
        if (!alive) return;
        if (result.ok) {
          setValue(result.value);
          setError('');
        } else {
          setValue(null);
          setError(result.error.message);
        }
      } catch {
        if (alive) {
          setValue(null);
          setError('倒计时读取失败，请重新读取数据。');
        }
      } finally {
        pending = false;
      }
    };
    void read();
    const interval = setInterval(() => void read(), 5000);
    const resume = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      alive = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [epoch]);
  if (error)
    return (
      <p className="countdown-home" role="alert">
        {error}
      </p>
    );
  return value ? (
    <div className="countdown-home" aria-label="首页高考倒计时">
      {value.setting.name}：
      {value.status === 'future'
        ? `剩余 ${value.remainingDays} 天`
        : value.status === 'today'
          ? '目标日期已到'
          : '目标日期已过'}{' '}
      · {value.setting.targetDate} · {value.setting.timeZone}
    </div>
  ) : null;
}
