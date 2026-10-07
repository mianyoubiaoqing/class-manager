import { useMemo, useState } from 'react';
import { Check, RotateCcw, UsersRound } from 'lucide-react';
import type { DesktopApi } from '../shared/contracts';
import type { DutyDraft } from '../shared/duty';
import { dutyCounts, dutyMemberLabel, dutyTime } from './duty-editor';

type Change = Parameters<DesktopApi['adjustDuty']>[0]['change'];
export function DutySchedule({
  arrangement,
  protectedDate,
  disabled,
  canComplete,
  onChange,
}: {
  arrangement: DutyDraft;
  protectedDate: string;
  disabled: boolean;
  canComplete: boolean;
  onChange?: (change: Change) => void;
}) {
  const [date, setDate] = useState(arrangement.dates[0]!);
  const [week, setWeek] = useState(0),
    [showDay, setShowDay] = useState(false);
  const first = new Date(`${arrangement.dates[0]}T00:00:00Z`);
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7) + week * 7);
  const weekDays = Array.from(
    {
      length: arrangement.dates.some((d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))
        ? 7
        : 5,
    },
    (_, i) => {
      const value = new Date(first);
      value.setUTCDate(value.getUTCDate() + i);
      return value.toISOString().slice(0, 10);
    },
  );
  const last = arrangement.dates[arrangement.dates.length - 1]!;
  const day = arrangement.days.find((item) => item.date === date);
  const frozen = !day || day.completed || day.date < protectedDate;
  const editing = Boolean(onChange);
  const counts = useMemo(() => dutyCounts(arrangement), [arrangement]);
  return (
    <div className="duty-schedule">
      <section className="duty-week-panel">
        <header className="flow-panel-heading">
          <div>
            <h2>每周安排</h2>
            <p>预览确认后，生成本周值日表。点击日期查看岗位与成员。</p>
          </div>
          <div className="button-row">
            <button disabled={disabled || week === 0} onClick={() => setWeek(week - 1)}>
              上一周
            </button>
            <span>{weekDays[0]} 起</span>
            <button
              disabled={disabled || weekDays[weekDays.length - 1]! >= last}
              onClick={() => setWeek(week + 1)}
            >
              下一周
            </button>
          </div>
        </header>
        <div
          className="duty-week-grid"
          style={{ gridTemplateColumns: `repeat(${weekDays.length}, minmax(0,1fr))` }}
        >
          {weekDays.map((value, index) => {
            const scheduled = arrangement.days.find((d) => d.date === value);
            return (
              <button
                key={value}
                className={`duty-day-card ${date === value ? 'selected' : ''}`}
                disabled={disabled || !scheduled}
                onClick={() => {
                  setDate(value);
                  setShowDay(true);
                }}
                aria-label={`查看 ${value} 值日安排`}
              >
                <strong>{['周一', '周二', '周三', '周四', '周五', '周六', '周日'][index]}</strong>
                <small>{value.slice(5)}</small>
                {scheduled ? (
                  <>
                    <h3>{scheduled.groupName}</h3>
                    {scheduled.posts.slice(0, 3).map((post) => (
                      <p key={post.postId}>
                        <strong>{arrangement.posts.find((p) => p.id === post.postId)?.name}</strong>
                        <span>
                          {post.slots
                            .map((s) => (s ? dutyMemberLabel(arrangement, s.studentId) : '待安排'))
                            .join('、')}
                        </span>
                      </p>
                    ))}
                    <small>
                      {scheduled.completed
                        ? '已完成 · 已冻结'
                        : value < protectedDate
                          ? '历史安排 · 已冻结'
                          : '已安排'}
                    </small>
                  </>
                ) : (
                  <span className="duty-day-empty">本期未安排</span>
                )}
              </button>
            );
          })}
        </div>
      </section>
      <details
        open={showDay}
        onToggle={(e) => setShowDay(e.currentTarget.open)}
        className="duty-day-detail"
      >
        <summary>查看与调整当天岗位</summary>
        <details>
          <summary>
            分组与次数 · {arrangement.groups.length} 组 · {arrangement.participantIds.length}{' '}
            名参与成员
          </summary>
          <div className="duty-table-scroll">
            <table aria-label="值日分组统计">
              <thead>
                <tr>
                  <th>当期组</th>
                  <th>值日天数</th>
                  <th>成员</th>
                </tr>
              </thead>
              <tbody>
                {arrangement.groups.map((group) => (
                  <tr key={group.id}>
                    <th>{group.name}</th>
                    <td>{counts.groups.get(group.id) ?? 0}</td>
                    <td>
                      {group.studentIds.map((id) => dutyMemberLabel(arrangement, id)).join('、') ||
                        '空组'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>成员岗位次数 · {arrangement.members.length} 份成员快照</summary>
            <div className="duty-table-scroll">
              <table aria-label="成员值日统计">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>岗位次数</th>
                    <th>当期状态</th>
                  </tr>
                </thead>
                <tbody>
                  {arrangement.members.map((member) => (
                    <tr key={member.studentId}>
                      <td>{dutyMemberLabel(arrangement, member.studentId)}</td>
                      <td>{counts.members.get(member.studentId) ?? 0}</td>
                      <td>
                        {arrangement.participantIds.includes(member.studentId)
                          ? '参与'
                          : '历史保留'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </details>
        <div className="duty-toolbar">
          <label>
            安排日期
            <select
              aria-label="查看值日日期"
              value={date}
              disabled={disabled}
              onChange={(e) => setDate(e.target.value)}
            >
              {arrangement.dates.map((date) => {
                const record = arrangement.days.find((day) => day.date === date);
                return (
                  <option key={date} value={date}>
                    {date} · {record?.groupName ?? '未安排'}
                    {record?.completed ? ' · 已完成' : ''}
                  </option>
                );
              })}
            </select>
          </label>
          {day && (
            <span>
              {day.completed ? '已完成 · 已冻结' : frozen ? '过去日期 · 已冻结' : '未完成'}
            </span>
          )}
          {onChange && (
            <button
              disabled={disabled || frozen}
              onClick={() => onChange({ kind: 'day-group', date, groupId: day!.groupId })}
            >
              <RotateCcw size={16} />
              重排当天岗位
            </button>
          )}
          {onChange && (
            <button
              disabled={disabled || !canComplete || !day || day.completed || date > protectedDate}
              onClick={() => onChange({ kind: 'complete', date })}
            >
              <Check size={16} />
              标记当天完成
            </button>
          )}
        </div>
        {!day ? (
          <p role="alert">此日期尚未安排。</p>
        ) : (
          <>
            <div className="duty-day-heading">
              <h3>
                {day.date} · {day.groupName}
              </h3>
              {onChange && (
                <label>
                  当日小组
                  <select
                    aria-label="当日值日小组"
                    value={day.groupId}
                    disabled={disabled || frozen}
                    onChange={(e) => onChange({ kind: 'day-group', date, groupId: e.target.value })}
                  >
                    {arrangement.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p>
                <UsersRound size={15} />
                {day.groupMemberIds.map((id) => dutyMemberLabel(arrangement, id)).join('、')}
              </p>
            </div>
            {day.posts.map((post) => {
              const definition = arrangement.posts.find((item) => item.id === post.postId)!;
              return (
                <section
                  className="duty-post"
                  key={post.postId}
                  aria-label={`值日岗位 ${definition.name}`}
                >
                  <h3>
                    {definition.name}{' '}
                    <small>
                      {dutyTime(definition.startMinute)}–{dutyTime(definition.endMinute)} ·{' '}
                      {definition.required} 人
                    </small>
                  </h3>
                  <ol className="duty-slots">
                    {post.slots.map((slot, index) => (
                      <li key={index} data-duty-slot={`${date}:${post.postId}:${index}`}>
                        {onChange ? (
                          <select
                            aria-label={`${definition.name} 第 ${index + 1} 人`}
                            value={slot?.studentId ?? ''}
                            disabled={disabled || frozen}
                            onChange={(e) =>
                              onChange({
                                kind: 'replace',
                                date,
                                postId: post.postId,
                                slotIndex: index,
                                studentId: e.target.value || null,
                              })
                            }
                          >
                            <option value="">空位</option>
                            {[
                              ...new Set([
                                ...arrangement.participantIds,
                                ...(slot ? [slot.studentId] : []),
                              ]),
                            ].map((id) => (
                              <option key={id} value={id}>
                                {dutyMemberLabel(arrangement, id)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span>
                            {slot ? dutyMemberLabel(arrangement, slot.studentId) : '空位'}
                          </span>
                        )}
                        <small className={!slot ? 'duty-warning' : ''}>
                          {slot?.temporaryReplacement ? '临时替换' : slot ? '组内安排' : '缺口'}
                        </small>
                      </li>
                    ))}
                  </ol>
                </section>
              );
            })}
            <details>
              <summary>
                当日不可用 ·{' '}
                {arrangement.unavailable.find((item) => item.date === date)?.studentIds.length ?? 0}{' '}
                人
              </summary>
              <DutyAbsence
                arrangement={arrangement}
                date={date}
                disabled={disabled || frozen}
                editing={editing}
                onChange={onChange}
              />
            </details>
          </>
        )}
      </details>
    </div>
  );
}

function DutyAbsence({
  arrangement,
  date,
  disabled,
  editing,
  onChange,
}: {
  arrangement: DutyDraft;
  date: string;
  disabled: boolean;
  editing: boolean;
  onChange?: (change: Change) => void;
}) {
  const saved = arrangement.unavailable.find((item) => item.date === date)?.studentIds ?? [];
  if (!editing)
    return <p>{saved.map((id) => dutyMemberLabel(arrangement, id)).join('、') || '无'}</p>;
  return (
    <>
      <div className="duty-member-list" role="group" aria-label="当天不可用成员">
        {[...new Set([...arrangement.participantIds, ...saved])].map((id) => (
          <label key={id}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={saved.includes(id)}
              onChange={(e) =>
                onChange?.({
                  kind: 'unavailable',
                  date,
                  studentIds: e.target.checked ? [...saved, id] : saved.filter((v) => v !== id),
                })
              }
            />
            <span>{dutyMemberLabel(arrangement, id)}</span>
          </label>
        ))}
      </div>
    </>
  );
}
