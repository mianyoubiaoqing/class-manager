import { useState } from 'react';
import { CalendarPlus, Plus, Trash2, X } from 'lucide-react';
import type { DesktopApi, Student } from '../shared/contracts';
import { DUTY_LIMITS } from '../shared/duty';
import { dutyPrepareInput } from '../shared/duty-records';
import { dutyDateRange, dutyMinutes } from './duty-editor';

type Source = Extract<Parameters<DesktopApi['prepareDuty']>[0]['source'], { kind: 'new' }>;

export function DutyConfiguration({
  students,
  disabled,
  onPrepare,
  onCancel,
}: {
  students: Student[];
  disabled: boolean;
  onPrepare: (source: Source) => void;
  onCancel: () => void;
}) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const [title, setTitle] = useState('');
  const [first, setFirst] = useState(today);
  const [last, setLast] = useState(today);
  const [weekdays, setWeekdays] = useState([0, 1, 2, 3, 4, 5, 6]);
  const [dates, setDates] = useState<string[]>([]);
  const [selected, setSelected] = useState(students.slice(0, DUTY_LIMITS.members).map((s) => s.id));
  const [groupCount, setGroupCount] = useState(2);
  const [posts, setPosts] = useState([
    { id: crypto.randomUUID(), name: '教室清扫', start: '16:00', end: '16:20', required: 1 },
  ]);
  const [error, setError] = useState('');
  function addDates() {
    try {
      const next = [...new Set([...dates, ...dutyDateRange(first, last, weekdays)])].sort();
      if (next.length > DUTY_LIMITS.dates) throw new Error('最多选择 366 个日期。');
      setDates(next);
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '日期配置无效。');
    }
  }
  function prepare() {
    const source = {
      kind: 'new' as const,
      title,
      dates,
      participantIds: selected,
      groupCount,
      unavailable: [],
      posts: posts.map(({ id, name, start, end, required }) => ({
        id,
        name,
        startMinute: dutyMinutes(start),
        endMinute: dutyMinutes(end),
        required,
      })),
    };
    const parsed = dutyPrepareInput.shape.source.safeParse(source);
    if (!parsed.success) {
      setError(
        '请核对计划名称、日期、参与成员、组数与岗位。时段须为 HH:mm，结束时间晚于开始时间。',
      );
      return;
    }
    setError('');
    onPrepare(source);
  }
  return (
    <section aria-label="新一期值日配置" className="duty-configuration">
      <h2>新一期值日</h2>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <fieldset disabled={disabled}>
        <div className="duty-toolbar">
          <label>
            计划名称
            <input
              aria-label="值日计划名称"
              maxLength={60}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            组数
            <input
              aria-label="值日组数"
              type="number"
              min={1}
              max={100}
              value={groupCount}
              onChange={(e) => setGroupCount(Number(e.target.value))}
            />
          </label>
        </div>
        <h3>安排日期 · {dates.length} 天</h3>
        <div className="duty-toolbar">
          <label>
            开始日期
            <input
              aria-label="值日开始日期"
              type="date"
              value={first}
              onChange={(e) => setFirst(e.target.value)}
            />
          </label>
          <label>
            结束日期
            <input
              aria-label="值日结束日期"
              type="date"
              value={last}
              onChange={(e) => setLast(e.target.value)}
            />
          </label>
          <button type="button" onClick={addDates}>
            <CalendarPlus size={16} />
            添加日期
          </button>
        </div>
        <div className="duty-weekdays" role="group" aria-label="日期范围星期选项">
          {['日', '一', '二', '三', '四', '五', '六'].map((name, index) => (
            <label key={name}>
              <input
                type="checkbox"
                checked={weekdays.includes(index)}
                onChange={(e) =>
                  setWeekdays(
                    e.target.checked ? [...weekdays, index] : weekdays.filter((v) => v !== index),
                  )
                }
              />
              周{name}
            </label>
          ))}
        </div>
        <ul className="duty-dates" aria-label="已选值日日期">
          {dates.map((date) => (
            <li key={date}>
              <span>{date}</span>
              <button
                className="icon-button"
                title={`移除 ${date}`}
                aria-label={`移除日期 ${date}`}
                onClick={() => setDates(dates.filter((v) => v !== date))}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
        <h3>岗位 · {posts.length}</h3>
        {posts.map((post, index) => (
          <div className="duty-post-input" key={post.id}>
            <label>
              岗位名称
              <input
                aria-label={`岗位 ${index + 1} 名称`}
                maxLength={60}
                value={post.name}
                onChange={(e) =>
                  setPosts(
                    posts.map((p) => (p.id === post.id ? { ...p, name: e.target.value } : p)),
                  )
                }
              />
            </label>
            <label>
              开始
              <input
                aria-label={`岗位 ${index + 1} 开始`}
                value={post.start}
                maxLength={5}
                onChange={(e) =>
                  setPosts(
                    posts.map((p) => (p.id === post.id ? { ...p, start: e.target.value } : p)),
                  )
                }
              />
            </label>
            <label>
              结束
              <input
                aria-label={`岗位 ${index + 1} 结束`}
                value={post.end}
                maxLength={5}
                onChange={(e) =>
                  setPosts(posts.map((p) => (p.id === post.id ? { ...p, end: e.target.value } : p)))
                }
              />
            </label>
            <label>
              人数
              <input
                aria-label={`岗位 ${index + 1} 人数`}
                type="number"
                min={1}
                max={400}
                value={post.required}
                onChange={(e) =>
                  setPosts(
                    posts.map((p) =>
                      p.id === post.id ? { ...p, required: Number(e.target.value) } : p,
                    ),
                  )
                }
              />
            </label>
            <button
              className="icon-button outlined"
              title="删除岗位"
              aria-label={`删除岗位 ${index + 1}`}
              disabled={posts.length === 1}
              onClick={() => setPosts(posts.filter((p) => p.id !== post.id))}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <button
          disabled={posts.length >= DUTY_LIMITS.posts}
          onClick={() =>
            setPosts([
              ...posts,
              { id: crypto.randomUUID(), name: '', start: '16:20', end: '16:40', required: 1 },
            ])
          }
        >
          <Plus size={16} />
          添加岗位
        </button>
        <h3>
          参与成员 · {selected.length} / {students.length}
        </h3>
        <div className="duty-toolbar">
          <button
            disabled={students.length > DUTY_LIMITS.members}
            onClick={() => setSelected(students.map((s) => s.id))}
          >
            全选
          </button>
          <button onClick={() => setSelected([])}>清空选择</button>
        </div>
        <div className="duty-member-list" role="group" aria-label="值日参与成员">
          {students.map((student) => (
            <label key={student.id}>
              <input
                type="checkbox"
                checked={selected.includes(student.id)}
                disabled={!selected.includes(student.id) && selected.length >= DUTY_LIMITS.members}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, student.id]
                      : selected.filter((id) => id !== student.id),
                  )
                }
              />
              <span>
                {student.studentNumber} · {student.displayName}
              </span>
            </label>
          ))}
        </div>
        <div className="duty-toolbar">
          <button onClick={onCancel}>
            <X size={16} />
            取消新建
          </button>
          <button className="primary" onClick={prepare}>
            <Plus size={16} />
            生成值日草案
          </button>
        </div>
      </fieldset>
    </section>
  );
}
