import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Plus, Search, Upload, X } from 'lucide-react';
import { SharedStudentPage } from './StudentDetails';
import { WorkspaceLinks } from '../../WorkspaceNavigation';
import type { Snapshot } from '../../../shared/contracts';

type Props = ComponentProps<typeof SharedStudentPage> & {
  onEditStudent: (student: Snapshot['students'][number]) => void;
};

export function StudentDirectory(props: Props) {
  const { snapshot, selectedClass, onNavigate, onAddStudent, onImport, onEditStudent } = props;
  const classId = selectedClass === 'all' ? snapshot.classes[0]?.id : selectedClass;
  const students = snapshot.students.filter((s) => s.active && s.classId === classId);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState(props.initialStudentId);
  const filtered = students.filter((s) =>
    `${s.displayName} ${s.studentNumber}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const current = Math.min(page, pages - 1);
  const selected = students.find((s) => s.id === detailId);
  return (
    <section className="shared-students teacher-directory">
      <header className="shared-heading">
        <div>
          <h1>学生档案</h1>
          <p>找到学生，查看成绩、点名和成长记录。</p>
        </div>
      </header>
      <WorkspaceLinks view="students" onNavigate={onNavigate} />
      <section className="shared-card">
        <div className="teacher-directory-toolbar">
          <label className="shared-search">
            <Search size={17} />
            <input
              aria-label="搜索学生档案"
              placeholder="搜索姓名或学号"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <span className="teacher-directory-count">本班 {students.length} 人</span>
          <button onClick={onImport}>
            <Upload size={16} />
            导入名单 / 成绩
          </button>
          <button className="primary" disabled={!classId} onClick={onAddStudent}>
            <Plus size={16} />
            添加学生
          </button>
        </div>
        {students.length ? (
          <div className="shared-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>学号</th>
                  <th>姓名</th>
                  <th>班级</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(current * 20, current * 20 + 20).map((s) => (
                  <tr key={s.id}>
                    <td>{s.studentNumber}</td>
                    <td>
                      <button className="teacher-student-name" onClick={() => setDetailId(s.id)}>
                        {s.displayName}
                      </button>
                    </td>
                    <td>{s.className}</td>
                    <td>
                      <button
                        className="shared-text-button"
                        aria-label={`查看${s.displayName}档案`}
                        onClick={() => setDetailId(s.id)}
                      >
                        档案
                      </button>
                      <button
                        className="shared-text-button"
                        aria-label={`编辑${s.displayName}`}
                        onClick={() => onEditStudent(s)}
                      >
                        编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="teacher-directory-empty">
            <h2>还没有学生名单</h2>
            <p>导入一份名单即可开始，成绩可以以后添加。</p>
            <button className="primary" onClick={onImport}>
              导入学生名单
            </button>
          </div>
        )}
        {students.length > 0 && !filtered.length && <p>没有找到学生，请换个姓名或学号。</p>}
        {pages > 1 && (
          <div className="shared-pagination">
            <span>共 {filtered.length} 人 · 每页 20 人</span>
            <button disabled={!current} onClick={() => setPage(current - 1)}>
              上一页
            </button>
            <span>
              {current + 1} / {pages}
            </span>
            <button disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>
              下一页
            </button>
          </div>
        )}
        <button
          className="shared-text-button teacher-class-tools"
          onClick={() => onNavigate('roster')}
        >
          管理班级、转班或停用学生 →
        </button>
      </section>
      {selected && (
        <StudentDialog
          title={`学生档案 · ${selected.displayName}`}
          onClose={() => {
            setDetailId('');
            props.onSelectStudent('');
          }}
        >
          <SharedStudentPage
            {...props}
            initialStudentId={selected.id}
            onSelectStudent={setDetailId}
            compact
          />
        </StudentDialog>
      )}
    </section>
  );
}

function StudentDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="teacher-student-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button autoFocus aria-label="关闭学生档案" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="teacher-student-dialog-body">{children}</div>
    </dialog>
  );
}
