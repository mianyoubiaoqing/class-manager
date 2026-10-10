import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, CircleHelp, Plus, Upload } from 'lucide-react';
import type { Snapshot } from '../../../shared/contracts';
import type {
  ClassDataConfiguration,
  ClassDataPreview,
  ClassDataRow,
} from '../../../shared/class-data-import';
import { scoreText } from '../../score-editor';
import { WorkspaceLinks, type AppView } from '../../WorkspaceNavigation';
import { ImportedProfileDetails } from '../../ImportedProfileDetails';
import { SchoolRosterCells, SchoolRosterHeaders } from '../../SchoolRosterTable';

export function ClassDataImport({
  snapshot,
  classId,
  onSelectClass,
  onCreateClass,
  onSaved,
  onClose,
  onDirtyChange,
  onNavigate,
}: {
  snapshot: Snapshot;
  classId: string;
  onSelectClass: (id: string) => void;
  onCreateClass: () => void;
  onSaved: (snapshot: Snapshot) => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onNavigate: (view: AppView) => void;
}) {
  const api = window.classManager;
  const [preview, setPreview] = useState<ClassDataPreview>();
  const [configuration, setConfiguration] = useState<ClassDataConfiguration>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<{ text: string; code?: string }>();
  const [message, setMessage] = useState(''),
    [mappingOpen, setMappingOpen] = useState(false),
    [matching, setMatching] = useState(false),
    [page, setPage] = useState(0);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [problemsOnly, setProblemsOnly] = useState(false);
  const running = useRef(false),
    alive = useRef(true);
  const configChanged =
    !!preview && JSON.stringify(configuration) !== JSON.stringify(preview.configuration);
  const metadataOnlyChanged =
    !!preview &&
    !!configuration &&
    configChanged &&
    JSON.stringify({ ...configuration, examName: '', examDate: '' }) ===
      JSON.stringify({ ...preview.configuration, examName: '', examDate: '' });
  const errorRows = preview?.rows.filter((row) => row.status === 'error') ?? [];
  const errorReasons = [...new Set(errorRows.map((row) => row.message))];
  const tableRows = useMemo(() => {
    if (!preview) return [];
    const matchedScoreStudents = new Set(
      preview.rows
        .filter(
          (row) =>
            row.key.startsWith(`${preview.configuration.scoreSheet}:`) &&
            (row.status === 'new' || row.status === 'existing') &&
            row.studentId,
        )
        .map((row) => row.studentId),
    );
    return preview.rows
      .filter((row) => !problemsOnly || row.status === 'error' || row.status === 'unresolved')
      .filter(
        (row) =>
          !row.key.startsWith(`${preview.configuration.studentSheet}:`) ||
          row.scores.length > 0 ||
          Object.keys(row.profile ?? {}).length > 0 ||
          (row.status !== 'new' && row.status !== 'existing') ||
          !matchedScoreStudents.has(row.studentId),
      );
  }, [preview, problemsOnly]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onDirtyChange(false);
      void api.cancelClassData({ epoch: snapshot.epoch, classId }).catch(() => {});
    };
  }, [api, classId, snapshot.epoch, onDirtyChange]);
  useEffect(() => {
    onDirtyChange(busy || !!preview);
  }, [busy, preview, onDirtyChange]);
  useEffect(() => {
    setPreview(undefined);
    setConfiguration(undefined);
    setError(undefined);
    setPage(0);
    setProblemsOnly(false);
  }, [classId]);
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (e) {
      if (alive.current) {
        const text = e instanceof Error ? e.message : '连接中断，请重新核对资料。';
        if (preview) setMessage(text);
        else setError({ text });
      }
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function accept(value: ClassDataPreview) {
    setPreview(value);
    setConfiguration(value.configuration);
    setError(undefined);
    setPage(0);
    setProblemsOnly(false);
  }
  async function select() {
    if (!classId) {
      onCreateClass();
      return;
    }
    await run(async () => {
      setPreview(undefined);
      setConfiguration(undefined);
      setError(undefined);
      setMatching(false);
      const result = await api.selectClassData({ epoch: snapshot.epoch, classId });
      if (!alive.current) return;
      if (!result.ok) {
        setError({
          text: result.error.message,
          code: `${result.error.code} · ${result.error.operationId}`,
        });
        return;
      }
      if (result.value) {
        accept(result.value);
        setMatching(result.value.unresolved > 0);
      } else setMessage('已取消选择文件，尚未导入资料。');
    });
  }
  async function configure(next: ClassDataConfiguration) {
    await run(async () => {
      const result = await api.configureClassData(next);
      if (!alive.current) return;
      if (!result.ok) throw new Error(result.error.message);
      accept(result.value);
      if (!result.value.unresolved) setMatching(false);
    });
  }
  function resolve(row: ClassDataRow, action: 'existing' | 'new' | 'skip') {
    if (!configuration) return;
    const studentId = choices[row.key];
    void configure({
      ...configuration,
      resolutions: [
        ...configuration.resolutions.filter((r) => r.key !== row.key),
        { key: row.key, action, ...(action === 'existing' ? { studentId } : {}) },
      ],
    });
  }
  async function close() {
    await run(async () => {
      if (classId) {
        const result = await api.cancelClassData({ epoch: snapshot.epoch, classId });
        if (!result.ok) throw new Error(result.error.message);
      }
      if (alive.current) {
        onDirtyChange(false);
        onClose();
      }
    });
  }
  const heading = error
    ? '这个文件还没有读成功'
    : matching && preview
      ? `有 ${preview.unresolved} 条资料，需要你确认是谁`
      : preview
        ? '核对资料，保存后就能使用'
        : '先把班级资料准备好';
  const description = error
    ? '先解决文件读取问题，再继续核对。你已保存的班级资料不受影响。'
    : preview
      ? '只需核对这一次，各功能会读取同一份资料；确认保存前不会写入新资料。'
      : '学生信息、考试成绩在这里导入一次，点名、排班和成长档案直接使用。';
  return (
    <section className="class-data-import" aria-label="班级资料统一导入" aria-busy={busy}>
      <header className="shared-heading">
        <div>
          <h1>{heading}</h1>
          <p>{description}</p>
        </div>
        <button className="shared-text-button" disabled={busy} onClick={() => void close()}>
          {preview || error ? '取消导入' : '使用手动录入'}
        </button>
      </header>
      <WorkspaceLinks
        view={preview ? 'students' : 'classManagement'}
        onNavigate={onNavigate}
        disabled={busy || !!preview}
      />
      {(preview || error) && (
        <ol className="shared-import-steps" aria-label="导入进度">
          <li className={!preview ? 'active' : 'complete'}>
            {preview ? <Check size={16} /> : <b>1</b>} 选择文件
          </li>
          <li className={preview ? 'active' : ''}>
            <b>2</b> 核对并保存
          </li>
          <li>
            <b>3</b> 开始使用
          </li>
          <li>
            <button className="shared-text-button" disabled={busy} onClick={() => void select()}>
              重新选择文件
            </button>
          </li>
        </ol>
      )}
      {busy && (
        <p role="status" className="shared-notice">
          正在读取与核对本机资料，请稍候…
        </p>
      )}
      {message && (
        <p role="status" className="shared-notice">
          {message}
        </p>
      )}
      {!preview && !error && (
        <>
          <section className="shared-card shared-upload-card">
            <div className="shared-row">
              <span className="shared-icon">
                <Upload size={24} />
              </span>
              <div>
                <h2>从你现有的 Excel 表格开始</h2>
                <p>可以选择名单、成绩表，也可以同时选择两份文件。</p>
              </div>
              <span className="shared-badge push-right">首次使用 / 继续添加</span>
            </div>
            <div className="shared-file-area">
              <span className="shared-file-icon">XLSX</span>
              <div>
                <h3>点击选择学生信息 / 成绩文件</h3>
                <p>支持学校18列花名册、成绩表（.xlsx / UTF-8 .csv）；无需重新抄写。</p>
                <small>
                  只有成绩表？也可核对姓名后同时建立学生名册。最多两份文件，每份 5 MiB。
                </small>
              </div>
              <button className="primary" disabled={busy} onClick={() => void select()}>
                <Upload size={17} />
                {classId ? '选择学生信息 / 成绩文件' : '先创建班级，再选择文件'}
              </button>
            </div>
            <div className="shared-row shared-destination">
              <label>
                资料保存到哪个班级？
                <select
                  aria-label="资料导入班级"
                  value={classId}
                  disabled={busy || !!preview}
                  onChange={(e) => onSelectClass(e.target.value)}
                >
                  {!classId && <option value="">尚未创建班级</option>}
                  {snapshot.classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={busy} onClick={onCreateClass}>
                <Plus size={16} /> 新建班级
              </button>
              <span className="push-right">没有表格？</span>
              <button
                className="shared-text-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await api.exportRosterTemplate({
                      epoch: snapshot.epoch,
                      format: 'xlsx',
                    });
                    if (!r.ok) throw new Error(r.error.message);
                    if (alive.current)
                      setMessage(
                        r.value
                          ? '空白模板已下载。填写后再点击选择文件；下载不会导入学生。'
                          : '已取消下载模板。',
                      );
                  })
                }
              >
                下载空白模板
              </button>
            </div>
            <div className="shared-three-steps">
              {[
                ['1　选择文件', '选择已有表格，识别姓名、编号和科目。'],
                ['2　核对并保存', '检查名单、成绩与考试信息，再确认。'],
                ['3　在各功能直接使用', '同一班级名单和成绩，无需反复导入。'],
              ].map(([title, desc]) => (
                <div key={title}>
                  <strong>{title}</strong>
                  <p>{desc}</p>
                </div>
              ))}
            </div>
          </section>
          <div className="shared-two-columns">
            <section className="shared-card">
              <h3>
                学生资料{' '}
                <span className="shared-badge neutral">
                  {snapshot.students.some((s) => s.active && s.classId === classId)
                    ? '已有名单'
                    : '待导入'}
                </span>
              </h3>
              <p>
                导入后可以点名、排座位、安排值日，
                <br />
                并为每位学生持续记录成长。
              </p>
            </section>
            <section className="shared-card">
              <h3>
                考试成绩 <span className="shared-badge neutral">可稍后添加</span>
              </h3>
              <p>
                导入后可以查看成绩变化、筛选学生，
                <br />
                并在成长总结中选择已有成绩。
              </p>
            </section>
          </div>
          <p className="shared-note">首次使用只需要准备一次。保存资料后，将自动进入班级总览。</p>
        </>
      )}
      {error && (
        <section className="shared-card">
          <div className="shared-error" role="alert">
            <h2>暂时无法读取这份资料</h2>
            <p>{error.text}</p>
            <hr />
            <h3>可以按下面的方法重新保存</h3>
            <div className="shared-two-columns">
              <section className="shared-card">
                <h3>方法一：重新保存为 .xlsx</h3>
                <p>
                  在 Excel / WPS 中打开文件，
                  <br />
                  选择“另存为”，保存为新的 .xlsx 文件。
                </p>
              </section>
              <section className="shared-card">
                <h3>方法二：只保留实际数据</h3>
                <p>
                  复制表头和有学生数据的行，
                  <br />
                  粘贴到新工作簿后保存。
                </p>
              </section>
            </div>
            <div className="shared-row">
              <button className="primary" disabled={busy} onClick={() => void select()}>
                <Upload size={16} />
                重新选择文件
              </button>
              <button
                onClick={() =>
                  setMessage(
                    '在 Excel / WPS 中选择“另存为”，文件类型选 CSV UTF-8（逗号分隔）。每个 CSV 只包含当前工作表；保留原文件后重新选择即可。',
                  )
                }
              >
                查看 CSV 导入方法
              </button>
            </div>
            {error.code && (
              <details>
                <summary>展开技术详情</summary>
                <code>{error.code}</code>
              </details>
            )}
            <small>保留原文件，修改后重新选择即可。当前没有保存新资料。</small>
          </div>
          <footer className="shared-footer">
            <div>
              <strong>下一步：修复文件后重新选择</strong>
              <p>无需重新创建班级，也不会覆盖已有资料。</p>
            </div>
            <button disabled={busy} onClick={() => void close()}>
              返回班级资料
            </button>
          </footer>
        </section>
      )}
      {preview && configuration && matching && (
        <>
          <div className="shared-warning">
            <CircleHelp size={18} />
            <strong>
              已匹配 {preview.matched} 人 · {preview.unresolved} 行待核对
            </strong>
            <span>同名或未找到的学生需要你确认，不会自动合并或直接新增。</span>
          </div>
          <section className="shared-card">
            <div className="shared-row">
              <div>
                <h2>按表格行号处理</h2>
                <p>
                  班级：{preview.className} · 考试：{configuration.examName || '仅学生资料'}
                </p>
              </div>
              <button className="shared-text-button push-right" onClick={() => setMatching(false)}>
                查看全部核对结果
              </button>
            </div>
            {preview.rows
              .filter((r) => r.status === 'unresolved')
              .slice(0, 20)
              .map((row) => (
                <section className="shared-match-row" key={row.key}>
                  <div className="shared-row">
                    <span className="shared-badge warning">第 {row.row} 行</span>
                    <strong>姓名：{row.displayName}</strong>
                    <small className="push-right">{row.sheet}</small>
                  </div>
                  <p>{row.message}</p>
                  <label>
                    这条资料属于谁？
                    <select
                      aria-label={`第${row.row}行匹配学生`}
                      value={choices[row.key] ?? ''}
                      onChange={(e) => setChoices({ ...choices, [row.key]: e.target.value })}
                    >
                      <option value="">请选择已有学生（按编号核对）</option>
                      {snapshot.students
                        .filter((s) => s.active && s.classId === classId)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.studentNumber} / {s.displayName}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="shared-row">
                    <button
                      className="primary"
                      disabled={busy || !choices[row.key]}
                      onClick={() => resolve(row, 'existing')}
                    >
                      确认这位学生
                    </button>
                    <button disabled={busy} onClick={() => resolve(row, 'new')}>
                      确认新增到本班
                    </button>
                    <button
                      className="shared-text-button push-right"
                      disabled={busy}
                      onClick={() => resolve(row, 'skip')}
                    >
                      本次跳过这行
                    </button>
                  </div>
                </section>
              ))}
            <p className="shared-note">
              每次显示最多 20 条待核对资料。处理后会显示后续资料；确认新增的信息会在保存前预览。
            </p>
            <footer className="shared-footer">
              <div>
                <strong>还有 {preview.unresolved} 行待处理</strong>
                <p>当前未保存新资料，已有名册与记录保持原样。</p>
              </div>
              <button disabled={busy} onClick={() => setMatching(false)}>
                返回核对表格
              </button>
              <button disabled>处理后确认保存</button>
            </footer>
          </section>
        </>
      )}
      {preview && configuration && !matching && (
        <section className="shared-card shared-preview-card">
          <div className="shared-row">
            <span className="shared-file-icon compact">XLSX</span>
            <div>
              <h3>{preview.fileNames.join(' + ')}</h3>
              <small>已读取文件，请核对工作表与考试信息</small>
            </div>
            <span className="shared-badge push-right">
              <Check size={14} />
              已识别 {preview.matched + preview.added} 名学生 · {preview.subjects.length} 科成绩
            </span>
          </div>
          <div className="shared-notice">
            <Check size={18} />
            <span>姓名、学生编号和科目已对应。表格原有列名无需修改。</span>
            <button className="shared-text-button" onClick={() => setMappingOpen(!mappingOpen)}>
              {mappingOpen ? '收起列对应' : '查看列对应与工作表'}
            </button>
          </div>
          {mappingOpen && (
            <section className="shared-mapping" aria-label="工作表与列对应">
              <div className="shared-two-columns">
                {(['studentSheet', 'scoreSheet'] as const).map((key) => (
                  <label key={key}>
                    {key === 'studentSheet' ? '学生信息工作表' : '考试成绩工作表'}
                    <select
                      aria-label={key === 'studentSheet' ? '学生信息工作表' : '考试成绩工作表'}
                      value={configuration[key] ?? ''}
                      disabled={busy}
                      onChange={(e) => {
                        const sheet = preview.sheets.find((s) => s.key === e.target.value);
                        setConfiguration({
                          ...configuration,
                          [key]: e.target.value || null,
                          ...(key === 'scoreSheet'
                            ? {
                                subjects:
                                  sheet?.headers
                                    .filter(
                                      (h) =>
                                        ![
                                          '姓名',
                                          '学生姓名',
                                          '学生编号',
                                          '学号',
                                          '编号',
                                          '班级',
                                          '总分',
                                          '排名',
                                          '名次',
                                          '序号',
                                        ].includes(h),
                                    )
                                    .map((header) => ({
                                      header,
                                      name: header,
                                      maxScore: /语文|数学|英语/.test(header) ? '150' : '100',
                                      precision: 0,
                                    })) ?? [],
                              }
                            : {}),
                        });
                      }}
                    >
                      <option value="">
                        本次不导入{key === 'studentSheet' ? '学生信息' : '成绩'}
                      </option>
                      {preview.sheets.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p className="shared-note">
                学生信息至少包含“姓名”，编号可选；仅导入成绩时也会核对学生。其他资料列不会作为科目保存。
              </p>
              {configuration.subjects.map((subject, index) => (
                <div className="shared-subject-row" key={index}>
                  <span>原列：{subject.header}</span>
                  <label>
                    科目名称
                    <input
                      aria-label={`${subject.header}科目名称`}
                      value={subject.name}
                      onChange={(e) =>
                        setConfiguration({
                          ...configuration,
                          subjects: configuration.subjects.map((s, i) =>
                            i === index ? { ...s, name: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    满分
                    <input
                      aria-label={`${subject.header}满分`}
                      value={subject.maxScore}
                      onChange={(e) =>
                        setConfiguration({
                          ...configuration,
                          subjects: configuration.subjects.map((s, i) =>
                            i === index ? { ...s, maxScore: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    小数位
                    <select
                      aria-label={`${subject.header}小数位`}
                      value={subject.precision}
                      onChange={(e) =>
                        setConfiguration({
                          ...configuration,
                          subjects: configuration.subjects.map((s, i) =>
                            i === index ? { ...s, precision: Number(e.target.value) } : s,
                          ),
                        })
                      }
                    >
                      <option value={0}>整数</option>
                      <option value={1}>1 位</option>
                      <option value={2}>2 位</option>
                    </select>
                  </label>
                  <button
                    disabled={busy}
                    onClick={() =>
                      setConfiguration({
                        ...configuration,
                        subjects: configuration.subjects.filter((_, i) => i !== index),
                      })
                    }
                  >
                    不导入此列
                  </button>
                </div>
              ))}
            </section>
          )}
          <div className="shared-exam-fields">
            <label>
              保存到班级
              <input readOnly value={preview.className} />
            </label>
            {configuration.scoreSheet && (
              <>
                <label>
                  考试名称
                  <input
                    aria-label="统一导入考试名称"
                    value={configuration.examName}
                    placeholder="例如：十月月考，请填写便于辨认的名称"
                    maxLength={100}
                    disabled={busy}
                    onChange={(e) =>
                      setConfiguration({ ...configuration, examName: e.target.value })
                    }
                  />
                  {configuration.examName === '未命名考试' && (
                    <small>建议改成实际考试名称，便于以后查找。</small>
                  )}
                </label>
                <label>
                  考试日期
                  <input
                    type="date"
                    aria-label="统一导入考试日期"
                    value={configuration.examDate}
                    disabled={busy}
                    onChange={(e) =>
                      setConfiguration({ ...configuration, examDate: e.target.value })
                    }
                  />
                </label>
              </>
            )}
          </div>
          {preview.hasScores && (
            <div className="shared-row shared-subject-pills">
              <small>本次考试满分（请核对）</small>
              {configuration.subjects.map((s) => (
                <span className="shared-badge" key={s.header}>
                  {s.name} {s.maxScore}
                  {' · '}
                  {s.precision === 0 ? '整数' : `${s.precision} 位小数`}
                </span>
              ))}
              <button
                className="shared-text-button push-right"
                onClick={() => setMappingOpen(true)}
              >
                修改科目与满分
              </button>
            </div>
          )}
          {preview.issues.map((issue) => (
            <p role="alert" className="shared-warning" key={issue}>
              {issue}
            </p>
          ))}
          {preview.unresolved > 0 && (
            <div className="shared-warning">
              <strong>还有 {preview.unresolved} 行需要确认对应学生</strong>
              <button onClick={() => setMatching(true)}>核对学生匹配</button>
            </div>
          )}
          <div
            className={`shared-table-scroll ${preview.profileRows > 0 ? 'school-roster-scroll' : ''}`}
            tabIndex={0}
            role="region"
            aria-label="学生信息与成绩预览表格"
          >
            <table className={preview.profileRows > 0 ? 'school-roster-table' : undefined}>
              <thead>
                <tr>
                  {preview.profileRows > 0 ? (
                    <SchoolRosterHeaders />
                  ) : (
                    <>
                      <th>学号</th>
                      <th>姓名</th>
                    </>
                  )}
                  <th>来源行</th>
                  {preview.profileRows > 0 && <th>学生详细资料</th>}
                  {preview.subjects.map((s) => (
                    <th key={s.id}>
                      {s.name} / {s.maxScore}
                    </th>
                  ))}
                  <th>处理结果</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.slice(page * 3, page * 3 + 3).map((row) => (
                  <tr key={row.key}>
                    {preview.profileRows > 0 ? (
                      <SchoolRosterCells
                        studentNumber={row.studentNumber || '确认后生成'}
                        displayName={row.displayName || '缺少姓名'}
                        profile={row.profile}
                      />
                    ) : (
                      <>
                        <td>{row.studentNumber || '确认后生成'}</td>
                        <td>{row.displayName || '缺少姓名'}</td>
                      </>
                    )}
                    <td>
                      <small className="shared-row-source">
                        {row.sheet} · 第 {row.row} 行
                      </small>
                    </td>
                    {preview.profileRows > 0 && (
                      <td>
                        <ImportedProfileDetails profile={row.profile} />
                      </td>
                    )}
                    {preview.subjects.map((s) => (
                      <td key={s.id}>
                        {row.scores.find((v) => v.subjectId === s.id)
                          ? scoreText(row.scores.find((v) => v.subjectId === s.id)!.score)
                          : '—'}
                      </td>
                    ))}
                    <td>
                      <span
                        className={`shared-badge ${row.status === 'error' ? 'error' : row.status === 'unresolved' ? 'warning' : ''}`}
                      >
                        {row.message}
                      </span>
                      {row.status === 'error' && (
                        <button disabled={busy} onClick={() => resolve(row, 'skip')}>
                          跳过此行
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="shared-row shared-pagination">
            {problemsOnly && (
              <button
                onClick={() => {
                  setProblemsOnly(false);
                  setPage(0);
                }}
              >
                查看全部资料
              </button>
            )}
            <small>
              共 {tableRows.length} 条核对结果
              {tableRows.length !== preview.rows.length && ` · 原表 ${preview.rows.length} 行`}
              {' · 每页 3 条'}
            </small>
            <div className="push-right">
              <button
                aria-label="资料上一页"
                disabled={page === 0 || busy}
                onClick={() => setPage(page - 1)}
              >
                ‹
              </button>
              <span>
                {page + 1} / {Math.max(1, Math.ceil(tableRows.length / 3))}
              </span>
              <button
                aria-label="资料下一页"
                disabled={(page + 1) * 3 >= tableRows.length || busy}
                onClick={() => setPage(page + 1)}
              >
                ›
              </button>
            </div>
          </div>
          <p className="shared-note">
            缺少编号时，确认后生成本地学生编号。后续优先按编号匹配；仅本班唯一姓名可自动匹配，同名须人工确认。当前按原始分保存，请核对满分与小数位。
          </p>
          <footer className="shared-footer">
            <div>
              <strong>
                将保存：新增 {preview.added} 名学生 · 保存 {preview.profileRows} 份详细档案
                {preview.hasScores ? ' + 1 次考试' : ''}
              </strong>
              <p>已有资料不会被覆盖。新资料保存后供点名、排班和成长档案共用。</p>
              {configChanged ? (
                <p role="status" className="shared-warning">
                  {metadataOnlyChanged
                    ? '名称或日期已修改，尚未保存。点击“确认保存并开始使用”将一并核对并保存。'
                    : '科目或匹配设置已修改，尚未保存。请先更新核对结果，再确认保存。'}
                </p>
              ) : (
                !preview.canConfirm && (
                  <div role="alert" aria-label="保存前需处理" className="shared-warning">
                    <strong>
                      暂不能保存：
                      {errorRows.length
                        ? `${errorRows.length} 行资料有问题。`
                        : preview.unresolved
                          ? `${preview.unresolved} 行学生尚未匹配。`
                          : preview.issues.length
                            ? preview.issues.join('；')
                            : '本次没有新增资料。'}
                    </strong>
                    {errorReasons.length > 0 && <p>{errorReasons.slice(0, 3).join('；')}</p>}
                    {errorReasons.some((reason) => reason.includes('小数位')) && (
                      <p>请在“修改科目与满分”中调整小数位，再更新核对结果。</p>
                    )}
                    {(errorRows.length > 0 || preview.unresolved > 0) && (
                      <button
                        onClick={() => {
                          setProblemsOnly(true);
                          setPage(0);
                        }}
                      >
                        查看问题行
                      </button>
                    )}
                  </div>
                )
              )}
            </div>
            <button disabled={busy} onClick={() => void close()}>
              <ArrowLeft size={15} />
              返回
            </button>
            {configChanged && !metadataOnlyChanged ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void configure(configuration)}
              >
                更新核对结果
              </button>
            ) : (
              <button
                className="primary"
                disabled={busy || (!metadataOnlyChanged && !preview.canConfirm)}
                onClick={() =>
                  void run(async () => {
                    let ready = preview;
                    if (metadataOnlyChanged) {
                      const updated = await api.configureClassData(configuration);
                      if (!alive.current) return;
                      if (!updated.ok) throw new Error(updated.error.message);
                      ready = updated.value;
                      accept(ready);
                      if (!ready.canConfirm) {
                        setMessage('核对未通过，尚未保存。请处理保存按钮旁列出的问题。');
                        return;
                      }
                    }
                    const result = await api.confirmClassData({
                      epoch: snapshot.epoch,
                      token: ready.token,
                    });
                    if (!result.ok) throw new Error(result.error.message);
                    if (alive.current) {
                      onDirtyChange(false);
                      onSaved(result.value.snapshot);
                    }
                  })
                }
              >
                <Check size={16} />
                确认保存并开始使用
              </button>
            )}
          </footer>
          {!preview.canConfirm &&
            !preview.issues.length &&
            !preview.unresolved &&
            !preview.rows.some((r) => r.status === 'error') && (
              <p role="status" className="shared-note">
                本次资料均已存在，没有新增学生或成绩；可以返回班级总览继续使用。
              </p>
            )}
        </section>
      )}
    </section>
  );
}
