import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, X } from 'lucide-react';
import type { DesktopApi, Student } from '../shared/contracts';
import type { DutyDraft } from '../shared/duty';

type Change = Parameters<DesktopApi['adjustDuty']>[0]['change'];

/** Local group edits are staged together; only an explicit apply changes the private draft. */
export function DutyGroups({
  arrangement,
  students,
  disabled,
  onApply,
  onCancel,
}: {
  arrangement: DutyDraft;
  students: Student[];
  disabled: boolean;
  onApply: (change: Change) => void;
  onCancel: () => void;
}) {
  const [groups, setGroups] = useState(() => structuredClone(arrangement.groups));
  const active = new Set(students.map((student) => student.id));
  const candidates = [
    ...arrangement.members.filter((member) =>
      arrangement.participantIds.includes(member.studentId),
    ),
    ...students
      .filter((student) => !arrangement.participantIds.includes(student.id))
      .map((student) => ({
        studentId: student.id,
        studentNumber: student.studentNumber,
        displayName: student.displayName,
      })),
  ];
  function move(index: number, offset: number) {
    const next = [...groups];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    setGroups(next);
  }
  return (
    <section aria-label="当期分组调整" className="duty-groups">
      <h3>当期分组</h3>
      <fieldset disabled={disabled}>
        {groups.map((group, index) => (
          <div className="duty-toolbar" key={group.id}>
            <label>
              第 {index + 1} 组
              <input
                aria-label={`第 ${index + 1} 组名称`}
                maxLength={40}
                value={group.name}
                onChange={(e) =>
                  setGroups(
                    groups.map((g) => (g.id === group.id ? { ...g, name: e.target.value } : g)),
                  )
                }
              />
            </label>
            <span>{group.studentIds.length} 人</span>
            <button
              className="icon-button outlined"
              aria-label={`第 ${index + 1} 组上移`}
              title="上移小组"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUp size={16} />
            </button>
            <button
              className="icon-button outlined"
              aria-label={`第 ${index + 1} 组下移`}
              title="下移小组"
              disabled={index === groups.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown size={16} />
            </button>
          </div>
        ))}
        <div className="duty-table-scroll">
          <table aria-label="当期参与分组">
            <thead>
              <tr>
                <th>成员</th>
                <th>分组</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((member) => (
                <tr key={member.studentId}>
                  <td>
                    {member.studentNumber} · {member.displayName}
                    {!active.has(member.studentId) && (
                      <strong className="duty-warning"> · 已不在本班有效名册</strong>
                    )}
                  </td>
                  <td>
                    <select
                      aria-label={`成员分组 ${member.studentNumber}`}
                      value={groups.find((g) => g.studentIds.includes(member.studentId))?.id ?? ''}
                      onChange={(e) =>
                        setGroups(
                          groups.map((g) => ({
                            ...g,
                            studentIds: [
                              ...g.studentIds.filter((id) => id !== member.studentId),
                              ...(g.id === e.target.value ? [member.studentId] : []),
                            ],
                          })),
                        )
                      }
                    >
                      <option value="">不参与本期</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id} disabled={!active.has(member.studentId)}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="duty-toolbar">
          <button onClick={onCancel}>
            <X size={16} />
            放弃分组调整
          </button>
          <button
            onClick={() =>
              onApply({
                kind: 'participants',
                participantIds: groups.flatMap((g) => g.studentIds),
                groups,
              })
            }
          >
            <Check size={16} />
            应用分组与参与名单
          </button>
        </div>
      </fieldset>
    </section>
  );
}
