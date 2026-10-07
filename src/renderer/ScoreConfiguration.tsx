import { useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ScoreSubject } from '../shared/scores';
import {
  customSubject,
  SUBJECT_CATALOG,
  type ExamDraft,
  type ScoreConfiguration as Configuration,
} from './score-editor';

export function ScoreConfiguration({
  draft,
  change,
  reportError,
}: {
  draft: ExamDraft;
  change: (configuration: Configuration) => void;
  reportError: (message: string) => void;
}) {
  const config = draft.configuration;
  const currentConfiguration = useRef(config);
  currentConfiguration.current = config;
  const [customName, setCustomName] = useState('');
  const [adding, setAdding] = useState(false);
  const [rosterPage, setRosterPage] = useState(0);
  const [filter, setFilter] = useState('');
  const filtered = draft.roster.filter((student) =>
    `${student.studentNumber} ${student.displayName}`.includes(filter),
  );
  const page = Math.min(rosterPage, Math.max(0, Math.ceil(filtered.length / 20) - 1));
  function addSubject(subject: ScoreSubject) {
    if (config.subjects.some((item) => item.id === subject.id)) return;
    change({
      ...config,
      subjects: [...config.subjects, subject],
      groups: config.groups.map((group) => ({
        ...group,
        subjectIds: [...group.subjectIds, subject.id],
      })),
    });
  }
  function removeSubject(id: string) {
    change({
      ...config,
      subjects: config.subjects.filter((subject) => subject.id !== id),
      groups: config.groups.map((group) => ({
        ...group,
        subjectIds: group.subjectIds.filter((value) => value !== id),
      })),
      columnMappings: config.columnMappings?.filter((mapping) => mapping.subjectId !== id),
    });
  }
  return (
    <>
      <h2>1 · 考试信息</h2>
      <p className="field-hint">
        填写考试名称与日期，并确认成绩表使用原始分。学年、学期与年级也可修改。
      </p>
      <div className="score-fields">
        {(
          [
            ['name', '考试名称'],
            ['date', '考试日期'],
            ['academicYear', '学年'],
            ['term', '学期'],
            ['grade', '年级'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              aria-label={label}
              type={key === 'date' ? 'date' : 'text'}
              value={config.definition[key]}
              maxLength={key === 'name' ? 100 : 30}
              onChange={(event) =>
                change({
                  ...config,
                  definition: { ...config.definition, [key]: event.target.value },
                })
              }
            />
          </label>
        ))}
        <label>
          分数口径
          <select
            aria-label="分数口径"
            value={config.scoreBasis}
            onChange={(event) =>
              change({ ...config, scoreBasis: event.target.value as Configuration['scoreBasis'] })
            }
          >
            <option value="raw">原始分</option>
            <option value="converted">赋分 / 转换分</option>
            <option value="unknown">尚未确认</option>
          </select>
        </label>
      </div>
      <section className="score-section score-subject-setup">
        <h2>2 · 选择科目与满分</h2>
        <p className="field-hint">
          只保留这次考试的科目。目标分可不填；小数位选择成绩表实际使用的位数。
        </p>
        <div className="score-actions">
          <select
            aria-label="添加标准科目"
            value=""
            disabled={config.subjects.length >= 20}
            onChange={(event) => {
              const subject = SUBJECT_CATALOG.find((item) => item.id === event.target.value);
              if (subject) addSubject({ ...subject });
            }}
          >
            <option value="">添加标准科目</option>
            {SUBJECT_CATALOG.filter(
              (subject) => !config.subjects.some((item) => item.id === subject.id),
            ).map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </select>
          <input
            aria-label="自定义科目名称"
            placeholder="自定义科目名称"
            maxLength={60}
            value={customName}
            onChange={(event) => setCustomName(event.target.value)}
          />
          <button
            type="button"
            disabled={adding || !customName.trim() || config.subjects.length >= 20}
            onClick={() => {
              setAdding(true);
              void customSubject(customName)
                .then((subject) => {
                  if (currentConfiguration.current !== config) {
                    reportError('配置已变化，请重新添加科目。');
                    return;
                  }
                  addSubject(subject);
                  setCustomName('');
                })
                .catch((error: unknown) =>
                  reportError(error instanceof Error ? error.message : '无法添加科目。'),
                )
                .finally(() => setAdding(false));
            }}
          >
            <Plus size={16} />
            添加科目
          </button>
        </div>
        <div className="score-table-scroll">
          <table>
            <thead>
              <tr>
                <th>科目</th>
                <th>满分</th>
                <th>小数位</th>
                <th>目标分（可空）</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {config.subjects.map((subject) => (
                <tr key={subject.id}>
                  <th>{subject.name}</th>
                  <td>
                    <input
                      aria-label={`${subject.name}满分`}
                      inputMode="decimal"
                      value={subject.maxScore}
                      onChange={(event) =>
                        change({
                          ...config,
                          subjects: config.subjects.map((item) =>
                            item.id === subject.id
                              ? { ...item, maxScore: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`${subject.name}小数位`}
                      value={subject.precision}
                      onChange={(event) =>
                        change({
                          ...config,
                          subjects: config.subjects.map((item) =>
                            item.id === subject.id
                              ? { ...item, precision: Number(event.target.value) as 0 | 1 | 2 }
                              : item,
                          ),
                        })
                      }
                    >
                      <option value="0">0</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label={`${subject.name}目标分`}
                      inputMode="decimal"
                      value={subject.targetScore ?? ''}
                      onChange={(event) =>
                        change({
                          ...config,
                          subjects: config.subjects.map((item) => {
                            if (item.id !== subject.id) return item;
                            const { targetScore: _target, ...rest } = item;
                            void _target;
                            return event.target.value
                              ? { ...rest, targetScore: event.target.value }
                              : rest;
                          }),
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除科目 ${subject.name}`}
                      title={`移除科目 ${subject.name}`}
                      disabled={config.subjects.length === 1}
                      onClick={() => removeSubject(subject.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <details
        className="score-section score-group-setup"
        open={config.groups.length > 1 || undefined}
      >
        <summary>不同学生考不同科目？设置计分组与名单</summary>
        <p className="field-hint">
          全班考相同科目时，保留默认“全科组”即可。选科不同的学生，可分配到只包含其应考科目的组。
        </p>
        <div className="score-actions">
          <h2>计分组</h2>
          <button
            type="button"
            disabled={config.groups.length >= 30}
            onClick={() =>
              change({
                ...config,
                groups: [
                  ...config.groups,
                  {
                    id: crypto.randomUUID(),
                    name: `计分组 ${config.groups.length + 1}`,
                    subjectIds: config.subjects.map((subject) => subject.id),
                  },
                ],
              })
            }
          >
            <Plus size={16} />
            新增计分组
          </button>
        </div>
        {config.groups.map((group) => (
          <div className="score-group" key={group.id}>
            <input
              aria-label={`计分组名称 ${group.name}`}
              value={group.name}
              maxLength={60}
              onChange={(event) =>
                change({
                  ...config,
                  groups: config.groups.map((item) =>
                    item.id === group.id ? { ...item, name: event.target.value } : item,
                  ),
                })
              }
            />
            {config.subjects.map((subject) => (
              <label className="score-check" key={subject.id}>
                <input
                  type="checkbox"
                  checked={group.subjectIds.includes(subject.id)}
                  onChange={(event) =>
                    change({
                      ...config,
                      groups: config.groups.map((item) =>
                        item.id === group.id
                          ? {
                              ...item,
                              subjectIds: event.target.checked
                                ? [...item.subjectIds, subject.id]
                                : item.subjectIds.filter((id) => id !== subject.id),
                            }
                          : item,
                      ),
                    })
                  }
                />
                {subject.name}
              </label>
            ))}
            <button
              type="button"
              className="icon-button"
              title={`删除计分组 ${group.name}`}
              aria-label={`删除计分组 ${group.name}`}
              disabled={
                config.groups.length === 1 ||
                config.assignments.some((student) => student.groupId === group.id)
              }
              onClick={() =>
                change({ ...config, groups: config.groups.filter((item) => item.id !== group.id) })
              }
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <div className="score-actions">
          <label>
            全班分配
            <select
              aria-label="全班分配计分组"
              value=""
              onChange={(event) =>
                change({
                  ...config,
                  assignments: config.assignments.map((item) => ({
                    ...item,
                    groupId: event.target.value,
                  })),
                })
              }
            >
              <option value="">选择计分组</option>
              {config.groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <input
            aria-label="筛选应考学生"
            placeholder="姓名 / 编号"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setRosterPage(0);
            }}
          />
          <span>应考 {draft.roster.length} 人</span>
        </div>
        <div className="score-table-scroll">
          <table>
            <thead>
              <tr>
                <th>编号</th>
                <th>姓名</th>
                <th>计分组</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(page * 20, page * 20 + 20).map((student) => (
                <tr key={student.studentId}>
                  <td>{student.studentNumber}</td>
                  <td>{student.displayName}</td>
                  <td>
                    <select
                      aria-label={`${student.studentNumber}计分组`}
                      value={
                        config.assignments.find((item) => item.studentId === student.studentId)
                          ?.groupId ?? ''
                      }
                      onChange={(event) =>
                        change({
                          ...config,
                          assignments: config.assignments.map((item) =>
                            item.studentId === student.studentId
                              ? { ...item, groupId: event.target.value }
                              : item,
                          ),
                        })
                      }
                    >
                      {config.groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="score-actions">
          <button type="button" disabled={page === 0} onClick={() => setRosterPage(page - 1)}>
            上一页
          </button>
          <span>
            {page + 1} / {Math.max(1, Math.ceil(filtered.length / 20))}
          </span>
          <button
            type="button"
            disabled={(page + 1) * 20 >= filtered.length}
            onClick={() => setRosterPage(page + 1)}
          >
            下一页
          </button>
        </div>
      </details>
      <label className="score-check">
        <input
          type="checkbox"
          checked={config.includeRanks ?? false}
          onChange={(event) => change({ ...config, includeRanks: event.target.checked })}
        />
        显示并列竞赛排名
      </label>
    </>
  );
}
