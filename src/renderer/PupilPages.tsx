import { useEffect, useRef, useState } from 'react';
import type { Result, Snapshot } from '../shared/contracts';
import {
  profileContent,
  type StudentProfile,
  type AttendanceRoster,
  type AttendanceRecord,
  type PupilRevision,
} from '../shared/pupils';
import './pupils.css';
import { WorkspaceTabs } from './WorkspaceTabs';

const labels = {
  unmarked: '未点名',
  present: '到课',
  late: '迟到',
  excused: '请假',
  absent: '缺席',
};
type Props = { snapshot: Snapshot; selectedClass: string; onDirtyChange: (dirty: boolean) => void };
function message<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const day = () => new Date().toLocaleDateString('sv-SE');

export function AttendancePage({ snapshot, selectedClass, onDirtyChange }: Props) {
  const api = window.classManager;
  const [classId, setClassId] = useState(
    selectedClass === 'all' ? (snapshot.classes[0]?.id ?? '') : selectedClass,
  );
  const [roster, setRoster] = useState<AttendanceRoster>(),
    [records, setRecords] = useState<AttendanceRecord[]>([]),
    [record, setRecord] = useState<AttendanceRecord>();
  const [rows, setRows] = useState<AttendanceRecord['rows']>([]),
    [title, setTitle] = useState('课堂点名'),
    [date, setDate] = useState(day),
    [reason, setReason] = useState('课堂点名记录');
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [review, setReview] = useState(false),
    [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<PupilRevision<AttendanceRecord>[]>([]);
  const [tab, setTab] = useState<'roll' | 'list' | 'history'>('roll');
  const [search, setSearch] = useState('');
  const alive = useRef(true),
    request = useRef(0),
    running = useRef(false),
    saveId = useRef<string | undefined>(undefined);
  useEffect(() => {
    onDirtyChange(dirty || busy || review);
    return () => onDirtyChange(false);
  }, [dirty, busy, review, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current++;
    };
  }, []);
  function fresh(next: AttendanceRoster) {
    setRoster(next);
    setRecord(undefined);
    setHistory([]);
    setRows(next.students.map((s) => ({ ...s, status: 'unmarked', note: '' })));
    setTitle('课堂点名');
    setDate(day());
    setCursor(0);
    setDirty(false);
    setReview(false);
    saveId.current = undefined;
  }
  async function load() {
    if (!classId) return;
    const serial = ++request.current;
    setBusy(true);
    try {
      const values = await Promise.all([
        api.readAttendanceRoster({ epoch: snapshot.epoch, classId }),
        api.listAttendance({ epoch: snapshot.epoch, classId }),
      ]);
      if (!alive.current || serial !== request.current) return;
      fresh(message(values[0]));
      setRecords(message(values[1]));
      setNotice('请选择状态，未点名的学生不会自动计为缺席。');
    } catch (e) {
      if (alive.current && serial === request.current)
        setNotice(e instanceof Error ? e.message : '读取失败。');
    } finally {
      if (alive.current && serial === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [classId, snapshot.epoch]);
  function mark(index: number, status: AttendanceRecord['rows'][number]['status']) {
    setRows(rows.map((row, i) => (i === index ? { ...row, status } : row)));
    setDirty(true);
    setReview(false);
    saveId.current = undefined;
  }
  async function read(id: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const [value, versions] = await Promise.all([
        api.readAttendance({ epoch: snapshot.epoch, id }),
        api.attendanceHistory({ epoch: snapshot.epoch, id }),
      ]);
      if (!alive.current) return;
      const next = message(value);
      setRecord(next);
      setRows(next.rows);
      setTitle(next.title);
      setDate(next.date);
      setHistory(message(versions));
      setDirty(false);
      setReview(false);
      setReason('更正点名记录');
      saveId.current = undefined;
    } catch (e) {
      if (alive.current) setNotice(e instanceof Error ? e.message : '读取失败。');
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    if (running.current || !roster) return;
    running.current = true;
    setBusy(true);
    const id = (saveId.current ??= crypto.randomUUID());
    try {
      const receipt = message(
        await api.saveAttendance({
          epoch: snapshot.epoch,
          classId,
          id: record?.id ?? null,
          expectedRevision: record?.revision ?? 0,
          expectedRosterHash: record?.rosterHash ?? roster.rosterHash,
          requestId: id,
          date,
          title,
          classroomId: record?.classroomId ?? null,
          marks: rows.map(({ studentId, status, note }) => ({ studentId, status, note })),
          reason,
        }),
      );
      if (!alive.current) return;
      const [current, list, versions] = await Promise.all([
        api.readAttendance({ epoch: snapshot.epoch, id: receipt.id }),
        api.listAttendance({ epoch: snapshot.epoch, classId }),
        api.attendanceHistory({ epoch: snapshot.epoch, id: receipt.id }),
      ]);
      if (!alive.current) return;
      setRecord(message(current));
      setRecords(message(list));
      setHistory(message(versions));
      setDirty(false);
      setReview(false);
      saveId.current = undefined;
      setNotice('点名记录已保存，后续更正会保留原版本。');
    } catch (e) {
      if (alive.current)
        setNotice(
          (e instanceof Error ? e.message : '保存回执不明。') + ' 请先核对历史记录，勿重复新建。',
        );
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const counts = Object.entries(labels)
    .map(([key, label]) => `${label} ${rows.filter((r) => r.status === key).length}人`)
    .join(' · ');
  return (
    <div className="pupil-page">
      <div className="pupil-toolbar">
        <label>
          点名班级
          <select
            aria-label="点名班级"
            value={classId}
            disabled={dirty || busy || review}
            onChange={(e) => setClassId(e.target.value)}
          >
            {snapshot.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy || !classId} onClick={() => void load()}>
          重新开始点名
        </button>
        <label>
          历史记录
          <select
            aria-label="点名历史"
            value={record?.id ?? ''}
            disabled={dirty || busy || review}
            onChange={(e) => {
              if (e.target.value) void read(e.target.value);
              else if (roster) fresh(roster);
            }}
          >
            <option value="">本次新点名</option>
            {records.map((r) => (
              <option key={r.id} value={r.id}>
                {r.date} · {r.title} · 第{r.revision}版
              </option>
            ))}
          </select>
        </label>
      </div>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <section className="pupil-panel">
        <div className="pupil-toolbar">
          <label>
            日期
            <input
              aria-label="点名日期"
              type="date"
              value={date}
              disabled={busy || review}
              onChange={(e) => {
                setDate(e.target.value);
                setDirty(true);
                saveId.current = undefined;
              }}
            />
          </label>
          <label>
            课时名称
            <input
              aria-label="点名课时名称"
              value={title}
              maxLength={120}
              disabled={busy || review}
              onChange={(e) => {
                setTitle(e.target.value);
                setDirty(true);
                saveId.current = undefined;
              }}
            />
          </label>
        </div>
        <WorkspaceTabs
          id="attendance"
          label="点名视图"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'roll', label: '逐人点名' },
            { value: 'list', label: '全班名单' },
            { value: 'history', label: '更正历史' },
          ]}
        />
        <div className="attendance-counts" aria-label="点名统计">
          {Object.entries(labels).map(([key, label]) => (
            <span key={key} className={`attendance-chip status-${key}`}>
              {label} <strong>{rows.filter((row) => row.status === key).length}</strong>
            </span>
          ))}
        </div>
        <div
          role="tabpanel"
          id="attendance-roll-panel"
          aria-labelledby="attendance-roll-tab"
          hidden={tab !== 'roll'}
        >
          {rows[cursor] && (
            <div className="roll-call-card" aria-label="逐人点名">
              <p>
                第 {cursor + 1} / {rows.length} 位
              </p>
              <progress
                aria-label="已点名进度"
                max={rows.length}
                value={rows.filter((row) => row.status !== 'unmarked').length}
              />
              <h2>{rows[cursor]!.displayName}</h2>
              <p>
                {rows[cursor]!.studentNumber} · {labels[rows[cursor]!.status]}
              </p>
              <div className="button-row">
                {(['present', 'late', 'excused', 'absent'] as const).map((status) => (
                  <button
                    key={status}
                    disabled={busy || review}
                    onClick={() => {
                      mark(cursor, status);
                      setCursor(Math.min(cursor + 1, rows.length - 1));
                    }}
                  >
                    {labels[status]}并下一位
                  </button>
                ))}
                <button
                  disabled={cursor === 0 || busy || review}
                  onClick={() => setCursor(cursor - 1)}
                >
                  上一位
                </button>
              </div>
            </div>
          )}
        </div>
        <div
          role="tabpanel"
          id="attendance-list-panel"
          aria-labelledby="attendance-list-tab"
          hidden={tab !== 'list'}
        >
          <input
            type="search"
            aria-label="查找点名学生"
            placeholder="查找姓名或学号"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="pupil-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>学号</th>
                  <th>学生</th>
                  <th>状态</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, index) =>
                  !search.trim() ||
                  `${r.displayName} ${r.studentNumber}`.includes(search.trim()) ? (
                    <tr key={r.studentId}>
                      <td>{r.studentNumber}</td>
                      <td>{r.displayName}</td>
                      <td>
                        <select
                          aria-label={`${r.displayName}点名状态`}
                          value={r.status}
                          disabled={busy || review}
                          onChange={(e) => mark(index, e.target.value as typeof r.status)}
                        >
                          {Object.entries(labels).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          aria-label={`${r.displayName}点名备注`}
                          value={r.note}
                          maxLength={300}
                          disabled={busy || review}
                          onChange={(e) => {
                            setRows(
                              rows.map((row, i) =>
                                i === index ? { ...row, note: e.target.value } : row,
                              ),
                            );
                            setDirty(true);
                            saveId.current = undefined;
                          }}
                        />
                      </td>
                    </tr>
                  ) : null,
                )}
              </tbody>
            </table>
          </div>
        </div>
        <label>
          保存或更正说明
          <input
            aria-label="点名保存说明"
            value={reason}
            maxLength={300}
            disabled={busy || review}
            onChange={(e) => {
              setReason(e.target.value);
              setDirty(true);
              saveId.current = undefined;
            }}
          />
        </label>
        {review ? (
          <div className="pupil-confirm" role="region" aria-label="点名保存确认">
            <p>
              请确认 {date} · {title}，{counts}。
              {record ? '原点名版本会保留。' : '保存当前名册快照。'}
            </p>
            <button className="primary" disabled={busy} onClick={() => void save()}>
              确认保存点名
            </button>
            <button disabled={busy} onClick={() => setReview(false)}>
              继续核对
            </button>
          </div>
        ) : (
          <button
            className="primary"
            disabled={
              busy || !rows.length || !title.trim() || !reason.trim() || (!dirty && !!record)
            }
            onClick={() => setReview(true)}
          >
            保存点名记录
          </button>
        )}
      </section>
      <section
        className="pupil-panel"
        role="tabpanel"
        id="attendance-history-panel"
        aria-labelledby="attendance-history-tab"
        hidden={tab !== 'history'}
      >
        <h2>更正历史</h2>
        {!history.length && (
          <p className="workspace-muted">选择一份已保存的点名记录，即可查看更正历史。</p>
        )}
        {history.map((v) => (
          <details key={v.record.revision}>
            <summary>
              第{v.record.revision}版 · {v.reason}
            </summary>
            <p>
              {v.record.date} · {v.record.title}
            </p>
            <ul>
              {v.record.rows
                .filter((r) => r.status !== 'present')
                .map((r) => (
                  <li key={r.studentId}>
                    {r.displayName}：{labels[r.status]} {r.note}
                  </li>
                ))}
            </ul>
          </details>
        ))}
      </section>
    </div>
  );
}

export function StudentProfilesPage({ snapshot, selectedClass, onDirtyChange }: Props) {
  const api = window.classManager;
  const students = snapshot.students.filter(
    (s) => selectedClass === 'all' || s.classId === selectedClass,
  );
  const [studentId, setStudentId] = useState(students[0]?.id ?? ''),
    [profile, setProfile] = useState<StudentProfile>();
  const [content, setContent] = useState(profileContent.parse({})),
    [history, setHistory] = useState<PupilRevision<StudentProfile>[]>([]);
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState(false),
    [reason, setReason] = useState('维护学生资料'),
    [notice, setNotice] = useState('');
  const alive = useRef(true),
    serial = useRef(0),
    running = useRef(false),
    saveId = useRef<string | undefined>(undefined);
  const student = snapshot.students.find((s) => s.id === studentId);
  const [tab, setTab] = useState<'teaching' | 'contact' | 'history'>('teaching');
  useEffect(() => {
    onDirtyChange(dirty || busy || review);
    return () => onDirtyChange(false);
  }, [dirty, busy, review, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      serial.current++;
    };
  }, []);
  useEffect(() => {
    if (!students.some((s) => s.id === studentId) && !dirty) setStudentId(students[0]?.id ?? '');
  }, [selectedClass, snapshot, studentId, dirty]);
  async function load() {
    if (!studentId) return;
    const request = ++serial.current;
    setBusy(true);
    try {
      const [result, versions] = await Promise.all([
        api.readStudentProfile({ epoch: snapshot.epoch, studentId }),
        api.studentProfileHistory({ epoch: snapshot.epoch, studentId }),
      ]);
      if (!alive.current || request !== serial.current) return;
      const value = message(result);
      setProfile(value);
      setContent(value.content);
      setHistory(message(versions));
      setDirty(false);
      setReview(false);
      saveId.current = undefined;
      setNotice('联系人、生日和地址仅供本机查看；模型只读取脱敏后的教学资料。');
    } catch (e) {
      if (alive.current && request === serial.current)
        setNotice(e instanceof Error ? e.message : '读取失败。');
    } finally {
      if (alive.current && request === serial.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [studentId, snapshot.epoch]);
  function edit<K extends keyof typeof content>(key: K, value: (typeof content)[K]) {
    setContent({ ...content, [key]: value });
    setDirty(true);
    setReview(false);
    saveId.current = undefined;
  }
  async function save() {
    if (running.current || !student || !profile) return;
    running.current = true;
    setBusy(true);
    try {
      message(
        await api.saveStudentProfile({
          epoch: snapshot.epoch,
          studentId,
          expectedRevision: profile.revision,
          expectedStudentRevision: student.revision,
          content,
          reason,
          requestId: (saveId.current ??= crypto.randomUUID()),
        }),
      );
      if (!alive.current) return;
      await load();
      setNotice('学生资料已保存，原修订保留。');
    } catch (e) {
      if (alive.current)
        setNotice((e instanceof Error ? e.message : '保存回执不明。') + ' 请先核对修订历史。');
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="pupil-page">
      <div className="pupil-toolbar">
        <label>
          选择学生
          <select
            aria-label="档案学生"
            value={studentId}
            disabled={dirty || busy || review}
            onChange={(e) => setStudentId(e.target.value)}
          >
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}（{s.studentNumber}）{s.active ? '' : ' · 已停用'}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy || !studentId} onClick={() => void load()}>
          重新读取资料
        </button>
      </div>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {student && profile && (
        <section className="pupil-panel">
          <h2>{student.displayName}的学生资料</h2>
          <p>
            {student.studentNumber} · {student.className} · {student.active ? '在籍' : '已停用'} ·
            第{profile.revision}版
          </p>
          <WorkspaceTabs
            id="profile"
            label="学生资料分类"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'teaching', label: '教学资料' },
              { value: 'contact', label: '基本与联系信息' },
              { value: 'history', label: '修订历史' },
            ]}
          />
          <div
            className="pupil-form-grid"
            role="tabpanel"
            id="profile-contact-panel"
            aria-labelledby="profile-contact-tab"
            hidden={tab !== 'contact'}
          >
            <label>
              性别
              <select
                aria-label="档案性别"
                value={content.gender}
                disabled={busy || review}
                onChange={(e) => edit('gender', e.target.value as typeof content.gender)}
              >
                <option value="unspecified">未填写</option>
                <option value="female">女</option>
                <option value="male">男</option>
                <option value="other">其他</option>
              </select>
            </label>
            <label>
              出生日期
              <input
                aria-label="档案出生日期"
                type="date"
                value={content.birthDate}
                disabled={busy || review}
                onChange={(e) => edit('birthDate', e.target.value)}
              />
            </label>
            {(
              [
                ['guardianName', '监护人姓名', 80],
                ['guardianPhone', '联系电话', 40],
                ['address', '联系地址', 300],
              ] as const
            ).map(([key, label, max]) => (
              <label key={key}>
                {label}
                <input
                  aria-label={label}
                  value={content[key]}
                  maxLength={max}
                  disabled={busy || review}
                  onChange={(e) => edit(key, e.target.value)}
                />
              </label>
            ))}
          </div>
          <div
            className="pupil-form-grid"
            role="tabpanel"
            id="profile-teaching-panel"
            aria-labelledby="profile-teaching-tab"
            hidden={tab !== 'teaching'}
          >
            {(
              [
                ['interests', '兴趣与特长'],
                ['strengths', '学习优势'],
                ['learningNeeds', '学习支持需求'],
                ['teacherNotes', '教师备注'],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <textarea
                  aria-label={label}
                  value={content[key]}
                  maxLength={2000}
                  rows={3}
                  disabled={busy || review}
                  onChange={(e) => edit(key, e.target.value)}
                />
              </label>
            ))}
          </div>
          <label>
            保存说明
            <input
              aria-label="档案保存说明"
              value={reason}
              maxLength={300}
              disabled={busy || review}
              onChange={(e) => {
                setReason(e.target.value);
                setDirty(true);
                saveId.current = undefined;
              }}
            />
          </label>
          {review ? (
            <div className="pupil-confirm" aria-label="学生资料保存确认">
              <p>确认保存 {student.displayName} 的上述资料？原版本和保存说明会保留。</p>
              <details className="workspace-disclosure" open>
                <summary>核对本次全部资料</summary>
                <dl className="profile-review">
                  {Object.entries({
                    性别:
                      content.gender === 'unspecified'
                        ? '未填写'
                        : content.gender === 'female'
                          ? '女'
                          : content.gender === 'male'
                            ? '男'
                            : '其他',
                    出生日期: content.birthDate,
                    监护人: content.guardianName,
                    联系电话: content.guardianPhone,
                    联系地址: content.address,
                    兴趣与特长: content.interests,
                    学习优势: content.strengths,
                    学习支持需求: content.learningNeeds,
                    教师备注: content.teacherNotes,
                  }).map(([label, text]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{text || '未填写'}</dd>
                    </div>
                  ))}
                </dl>
              </details>
              <button className="primary" disabled={busy} onClick={() => void save()}>
                确认保存学生资料
              </button>
              <button disabled={busy} onClick={() => setReview(false)}>
                继续修改
              </button>
            </div>
          ) : (
            <button
              className="primary"
              disabled={busy || !dirty || !reason.trim()}
              onClick={() => setReview(true)}
            >
              保存学生资料
            </button>
          )}
        </section>
      )}
      <section
        className="pupil-panel"
        role="tabpanel"
        id="profile-history-panel"
        aria-labelledby="profile-history-tab"
        hidden={tab !== 'history'}
      >
        <h2>资料修订历史</h2>
        {!history.length && <p className="workspace-muted">保存资料后，修订记录会显示在这里。</p>}
        {history.map((v) => (
          <details key={v.record.revision}>
            <summary>
              第{v.record.revision}版 · {v.reason}
            </summary>
            <p>兴趣：{v.record.content.interests || '未填写'}</p>
            <p>学习优势：{v.record.content.strengths || '未填写'}</p>
            <p>支持需求：{v.record.content.learningNeeds || '未填写'}</p>
            <p>教师备注：{v.record.content.teacherNotes || '未填写'}</p>
            <p>
              联系人：{v.record.content.guardianName} {v.record.content.guardianPhone}
            </p>
            <p>
              出生日期：{v.record.content.birthDate || '未填写'} · 地址：
              {v.record.content.address || '未填写'}
            </p>
          </details>
        ))}
      </section>
      {!students.length && <p className="empty-state">请先在班级名册中添加学生。</p>}
    </div>
  );
}
