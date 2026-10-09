import { useEffect, useRef, useState } from 'react';
import {
  Search,
  Menu,
  FolderOpen,
  Upload,
  Save,
  Download,
  ArrowLeft,
  ChevronRight,
} from 'lucide-react';
import {
  resourceSubjects,
  resourceTypes,
  resourceSection,
  resourceTemplate,
  type ResourceReadInput,
  type ResourceDocument,
  type ResourceAttachment,
} from '../../../shared/resource-library';
import type { FolderInventory } from '../../../shared/material-folders';
import type { Result } from '../../../shared/contracts';
import { TeachingDialog } from '../teaching/TeachingDialog';
import './resource-library.css';
const take = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
export function ResourceLibraryPage({
  epoch,
  onDirtyChange,
}: {
  epoch: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const api = window.classManager;
  const [subjectId, setSubjectId] = useState('zz'),
    [versionId, setVersionId] = useState('tb'),
    [key, setKey] = useState(''),
    [type, setType] = useState<ResourceReadInput['type']>('courseware');
  const [query, setQuery] = useState(''),
    [tree, setTree] = useState(false),
    [doc, setDoc] = useState<ResourceDocument>(),
    [body, setBody] = useState(''),
    [files, setFiles] = useState<ResourceAttachment[]>([]);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(false),
    [pending, setPending] = useState<() => void>();
  const [folder, setFolder] = useState<FolderInventory | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [children, setChildren] = useState(false),
    [folderOpen, setFolderOpen] = useState(false),
    [link, setLink] = useState<{ name: string; url: string }>();
  const lock = useRef(false),
    serial = useRef(0),
    alive = useRef(true);
  const subject = resourceSubjects.find((s) => s.id === subjectId)!,
    version = subject.versions.find((v) => v.id === versionId) ?? subject.versions[0]!;
  const loaded = !!doc && doc.key === key && doc.type === type;
  const dirty = loaded && body !== doc.body;
  useEffect(() => {
    onDirtyChange(dirty || busy || !!link);
    return () => onDirtyChange(false);
  }, [dirty, busy, link, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      serial.current++;
    };
  }, []);
  const request = { epoch, key, type };
  async function run<T>(work: () => Promise<T>, success?: string): Promise<T | undefined> {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice('');
    setError(false);
    try {
      const value = await work();
      if (alive.current && success) setNotice(success);
      return value;
    } catch (e) {
      if (alive.current) {
        setError(true);
        setNotice(e instanceof Error ? e.message : '操作未完成，请重试。');
      }
      return undefined;
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    const current = ++serial.current;
    setDoc(undefined);
    setBody('');
    setFiles([]);
    setNotice('');
    if (!key) return;
    void run(async () => {
      const [document, attachments] = await Promise.all([
        api.readResourceDocument({ epoch, key, type }),
        api.listResourceAttachments({ epoch, key, type }),
      ]);
      if (!alive.current || current !== serial.current) return;
      const d = take(document);
      setDoc(d);
      setBody(d.body);
      setFiles(take(attachments));
    });
  }, [epoch, key, type, api]);
  const move = (action: () => void) => {
    if (busy) return;
    if (dirty) setPending(() => action);
    else action();
  };
  function chooseSubject(id: string) {
    move(() => {
      setSubjectId(id);
      setVersionId(resourceSubjects.find((s) => s.id === id)!.versions[0]!.id);
      setKey('');
      setQuery('');
    });
  }
  async function refreshFiles() {
    const result = take(await api.listResourceAttachments(request));
    if (alive.current) setFiles(result);
  }
  const section = key ? resourceSection(key) : undefined;
  const hits = version.books.flatMap((book, b) =>
    book.units.flatMap((unit, u) =>
      unit.lessons.flatMap((lesson, l) =>
        lesson.sections.map((s, index) => ({
          key: `${subjectId}:${version.id}:b${b}:u${u}:l${l}:s${index}`,
          title: s.title,
          book,
          unit,
          lesson,
        })),
      ),
    ),
  );
  const filtered = hits.filter((s) =>
    [s.title, s.book.title, s.unit.title, s.lesson.title]
      .join(' ')
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  async function scan(choose: boolean, includeChildren = children) {
    const inventory = take(await api.scanResourceFolder({ epoch, choose, includeChildren }));
    if (alive.current) {
      setFolder(inventory);
      setSelected([]);
      setFolderOpen(!!inventory);
    }
  }
  return (
    <section className="rl-library" aria-label="学科教学资源库">
      <header className="rl-top">
        <button
          aria-label="展开教材目录"
          aria-expanded={tree}
          disabled={busy}
          onClick={() => setTree(!tree)}
        >
          <Menu size={19} />
        </button>
        <span className="rl-logo">教</span>
        <strong>学科教学资源库</strong>
        <label className="rl-search">
          <Search size={18} />
          <input
            aria-label="搜索框题或知识点"
            placeholder="搜索框题 / 知识点（如：矛盾、函数、光合作用）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={busy}
          />
        </label>
      </header>
      <div className="rl-subjects">
        <span>选择学科</span>
        <div>
          {resourceSubjects.map((s) => (
            <button
              key={s.id}
              aria-pressed={subjectId === s.id}
              className={subjectId === s.id ? 'active' : ''}
              disabled={busy}
              onClick={() => chooseSubject(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
        <label>
          教材版本
          <select
            aria-label="教材版本"
            value={version.id}
            disabled={busy}
            onChange={(e) =>
              move(() => {
                setVersionId(e.target.value);
                setKey('');
              })
            }
          >
            {subject.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={`rl-layout ${tree ? 'with-tree' : ''}`}>
        {tree && (
          <aside className="rl-tree">
            <button disabled={busy} onClick={() => move(() => setKey(''))}>
              教材总览
            </button>
            {version.books.map((b, bi) => (
              <details key={b.id} open={section?.book === b}>
                <summary>
                  {b.code} {b.title}
                </summary>
                {b.units.map((u, ui) => (
                  <details key={ui}>
                    <summary>{u.title}</summary>
                    {u.lessons.map((l, li) => (
                      <div key={li}>
                        <strong>{l.title}</strong>
                        {l.sections.map((s, si) => {
                          const target = `${subjectId}:${version.id}:b${bi}:u${ui}:l${li}:s${si}`;
                          return (
                            <button
                              key={si}
                              className={key === target ? 'active' : ''}
                              disabled={busy}
                              onClick={() => move(() => setKey(target))}
                            >
                              {s.title}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </details>
                ))}
              </details>
            ))}
          </aside>
        )}
        <div className="rl-main">
          <p className="rl-breadcrumb">
            <button disabled={busy} onClick={() => move(() => setKey(''))}>
              教材总览
            </button>
            {section && (
              <>
                {' '}
                <ChevronRight size={14} />
                {section.book.code} <ChevronRight size={14} />
                {section.section.title}
              </>
            )}
          </p>
          <h2>
            {section ? section.section.title : `高中${subject.name} · ${version.name} 教学资源库`}
          </h2>
          <p className="rl-summary">
            {section
              ? `${section.book.code} ${section.book.title} · ${section.lesson.title}`
              : `当前版本共 ${version.books.length} 册、${hits.length} 个框题。选择教材章节，编辑课件提纲、教学设计和复习资料；也可添加自己的教学文件。`}
          </p>
          {version.sharedOutline && (
            <p className="rl-note">
              此版本暂沿用客户提供的通用目录，请对照实际教材核对章节；模板内容可编辑。
            </p>
          )}
          <div className="rl-actions">
            <button
              className="rl-primary"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  take(await api.openResourceLink({ url: 'https://www.zxx.edu.cn/' })),
                )
              }
            >
              📖 教育部官方电子教材平台（阅读正版教材）
            </button>
          </div>
          {notice && (
            <p className={`rl-notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
              {notice}
            </p>
          )}
          {query.trim() ? (
            <div className="rl-search-results">
              <h3>搜索结果 · {filtered.length} 个框题</h3>
              {filtered.slice(0, 200).map((hit) => (
                <button
                  key={hit.key}
                  disabled={busy}
                  onClick={() =>
                    move(() => {
                      setKey(hit.key);
                      setQuery('');
                      setTree(true);
                    })
                  }
                >
                  <strong>{hit.title}</strong>
                  <span>
                    {hit.book.code} · {hit.book.title} · {hit.lesson.title}
                  </span>
                  <ChevronRight size={18} />
                </button>
              ))}
              {!filtered.length && <p>没有找到匹配内容，请换一个关键词。</p>}
            </div>
          ) : !section ? (
            <div className="rl-book-grid">
              {version.books.map((book, index) => (
                <button
                  className="rl-book"
                  key={book.id}
                  disabled={busy}
                  onClick={() =>
                    move(() => {
                      setKey(`${subjectId}:${version.id}:b${index}:u0:l0:s0`);
                      setTree(true);
                    })
                  }
                >
                  <span className="rl-badge">{book.code}</span>
                  <h3>{book.title}</h3>
                  <p>
                    适用 {book.grade} ·{' '}
                    {book.units.reduce(
                      (n, u) => n + u.lessons.reduce((n, l) => n + l.sections.length, 0),
                      0,
                    )}{' '}
                    个框题
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <>
              <nav className="rl-tabs" aria-label="教材章节资源类型">
                {Object.entries(resourceTypes).map(([id, label]) => (
                  <button
                    key={id}
                    className={type === id ? 'active' : ''}
                    aria-current={type === id ? 'page' : undefined}
                    disabled={busy}
                    onClick={() => move(() => setType(id as ResourceReadInput['type']))}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <div className="rl-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      take(
                        await api.openResourceLink({
                          url:
                            'https://search.zxxk.com/?keyword=' +
                            encodeURIComponent(
                              `高中${subject.name} ${version.name} ${section.section.title} ${resourceTypes[type]}`,
                            ),
                        }),
                      ),
                    )
                  }
                >
                  🔎 学科网 · 搜本课{resourceTypes[type]}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      take(
                        await api.openResourceLink({ url: 'https://basic.jxeduyun.com/homeIndex' }),
                      ),
                    )
                  }
                >
                  📚 赣教云 · 资源服务中心
                </button>
                <span className="rl-muted">外部平台可能需要登录；模板与本地文件可直接使用。</span>
              </div>
              <section className="rl-file-card">
                <div className="rl-card-head">
                  <div>
                    <h3>
                      <FolderOpen size={18} /> 我的{resourceTypes[type]}文件
                    </h3>
                    <p>添加后保存在本机并纳入备份。打开的是副本；修改后请重新添加文件。</p>
                  </div>
                  <div className="rl-actions">
                    <button
                      disabled={busy || !loaded}
                      onClick={() =>
                        void run(async () => {
                          const receipt = take(await api.selectResourceFiles(request));
                          await refreshFiles();
                          if (!receipt.cancelled)
                            setNotice(
                              receipt.files
                                .map((f) =>
                                  f.error ? `${f.name}：${f.error}` : `已添加：${f.name}`,
                                )
                                .join('；'),
                            );
                        })
                      }
                    >
                      <Upload size={16} />
                      添加本地文件
                    </button>
                    <button disabled={busy || !loaded} onClick={() => void run(() => scan(true))}>
                      读取文件夹
                    </button>
                    <button
                      disabled={busy || !loaded}
                      onClick={() => setLink({ name: '', url: '' })}
                    >
                      添加链接
                    </button>
                  </div>
                </div>
                {files.length ? (
                  <ul className="rl-files">
                    {files.map((f) => (
                      <li key={f.id}>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () =>
                              take(await api.openResourceAttachment({ ...request, id: f.id })),
                            )
                          }
                        >
                          {f.url ? '🔗' : '📄'} {f.name}
                        </button>
                        <span>{f.url ? '网页链接' : `${Math.ceil(f.bytes / 1024)} KB`}</span>
                        <button
                          disabled={busy}
                          onClick={() =>
                            setPending(() => () => {
                              void run(async () => {
                                take(await api.removeResourceAttachment({ ...request, id: f.id }));
                                await refreshFiles();
                              }, '已从本章节移除，原始文件仍保留。');
                            })
                          }
                        >
                          移除
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rl-muted">还没有添加文件。模板在下方，可直接编辑。</p>
                )}
              </section>
              <section className="rl-editor-card">
                <div className="rl-card-head">
                  <div>
                    <h3>可编辑{resourceTypes[type]}模板</h3>
                    <p>这是备课起点，请核对内容并补充本班学情。课件页导出的是 Word 提纲。</p>
                  </div>
                  <span className="rl-save-state">
                    {busy
                      ? '处理中…'
                      : dirty
                        ? '有未保存修改'
                        : doc?.updatedAt
                          ? `本机已保存 · ${new Date(doc.updatedAt).toLocaleString('zh-CN')}`
                          : '学科模板 · 尚未保存'}
                  </span>
                </div>
                <textarea
                  aria-label={`${resourceTypes[type]}内容`}
                  value={body}
                  readOnly={busy || !loaded}
                  maxLength={50000}
                  onChange={(e) => setBody(e.target.value)}
                />
                <div className="rl-actions">
                  <button
                    className="rl-primary"
                    disabled={busy || !loaded || !dirty}
                    onClick={() =>
                      void run(async () => {
                        const saved = take(
                          await api.saveResourceDocument({
                            ...request,
                            body,
                            expectedRevision: doc!.revision,
                            requestId: crypto.randomUUID(),
                          }),
                        );
                        if (alive.current) setDoc(saved);
                      }, '已保存到本机，备份会包含此内容。')
                    }
                  >
                    <Save size={16} />
                    保存修改
                  </button>
                  <button
                    disabled={busy || !loaded}
                    onClick={() => setPending(() => () => setBody(resourceTemplate(key, type)))}
                  >
                    恢复学科模板
                  </button>
                  <button
                    disabled={busy || !loaded}
                    onClick={() =>
                      void run(async () => {
                        const saved = take(await api.exportResourceDocument({ ...request, body }));
                        if (saved)
                          setNotice(`Word 已导出：${saved.path}。可使用 Word 或 WPS 打印。`);
                      })
                    }
                  >
                    <Download size={16} />
                    导出 Word（.docx）
                  </button>
                  <span>{body.length}/50000 字</span>
                  <button
                    disabled={busy || !loaded}
                    onClick={() =>
                      void run(async () =>
                        take(await api.previewResourcePrint({ ...request, body })),
                      )
                    }
                  >
                    打印预览
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
      {pending && (
        <TeachingDialog title="请确认当前操作" busy={busy} onClose={() => setPending(undefined)}>
          <p>
            {dirty
              ? '当前内容尚未保存，继续操作可能放弃这些修改。'
              : '是否继续？恢复模板会替换当前编辑内容；移除文件只解除本章节关联。'}
          </p>
          <div className="rl-actions">
            <button onClick={() => setPending(undefined)}>返回</button>
            <button
              onClick={() => {
                const action = pending;
                setPending(undefined);
                action();
              }}
            >
              确认继续
            </button>
          </div>
        </TeachingDialog>
      )}
      {link && (
        <TeachingDialog title="添加网页资料" busy={busy} onClose={() => setLink(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                take(await api.addResourceLink({ ...request, ...link }));
                await refreshFiles();
                setLink(undefined);
              }, '网页资料已保存。');
            }}
          >
            <label>
              资料名称
              <input
                required
                maxLength={200}
                value={link.name}
                disabled={busy}
                onChange={(e) => setLink({ ...link, name: e.target.value })}
              />
            </label>
            <label>
              HTTPS 地址
              <input
                required
                type="url"
                value={link.url}
                disabled={busy}
                onChange={(e) => setLink({ ...link, url: e.target.value })}
              />
            </label>
            <button disabled={busy}>保存链接</button>
          </form>
        </TeachingDialog>
      )}
      {folderOpen && folder && (
        <TeachingDialog
          title={`读取文件夹 · ${folder.folderName}`}
          busy={busy}
          onClose={() => setFolderOpen(false)}
        >
          <p>
            勾选文件后，将实际读取内容并复制保存到当前章节。支持 Office、PDF、图片、TXT 和
            MP4；单份不超过 32 MiB。
          </p>
          <label>
            <input
              type="checkbox"
              checked={children}
              disabled={busy}
              onChange={(e) => {
                setChildren(e.target.checked);
                void run(() => scan(false, e.target.checked));
              }}
            />
            包含子文件夹
          </label>
          {folder.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <div className="rl-folder-list">
            {folder.entries.map((f) => (
              <label key={f.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(f.id)}
                  disabled={
                    busy ||
                    f.status !== 'ready' ||
                    (!selected.includes(f.id) && selected.length >= 25)
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? [...selected, f.id] : selected.filter((id) => id !== f.id),
                    )
                  }
                />
                {f.name}
                <span>
                  {f.status === 'ready'
                    ? `${Math.ceil(f.bytes / 1024)} KB`
                    : f.status === 'unsupported'
                      ? '暂不支持'
                      : f.status === 'empty'
                        ? '空文件'
                        : '超过 32 MiB'}
                </span>
              </label>
            ))}
            {!folder.entries.length && <p>此目录中没有普通文件。</p>}
          </div>
          <div className="rl-actions">
            <button
              disabled={busy || !selected.length}
              onClick={() =>
                void run(async () => {
                  const receipt = take(
                    await api.readResourceFolder({
                      ...request,
                      token: folder.token,
                      ids: selected,
                    }),
                  );
                  await refreshFiles();
                  setFolderOpen(false);
                  setNotice(
                    receipt.files
                      .map((f) => (f.error ? `${f.name}：${f.error}` : `已读取：${f.name}`))
                      .join('；'),
                  );
                })
              }
            >
              读取并保存 {selected.length} 份文件
            </button>
            <button disabled={busy} onClick={() => void run(() => scan(false))}>
              重新扫描
            </button>
            <button disabled={busy} onClick={() => setFolderOpen(false)}>
              <ArrowLeft size={15} />
              返回章节
            </button>
          </div>
        </TeachingDialog>
      )}
    </section>
  );
}
