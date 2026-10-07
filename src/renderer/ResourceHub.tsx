import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  GraduationCap,
  Heart,
  MoreHorizontal,
  Plus,
  X,
} from 'lucide-react';
import { resourceLinkInput } from '../shared/material-folders';

interface Resource {
  id: string;
  name: string;
  description: string;
  url: string;
  group: 'platform' | 'listening' | 'public';
}
const defaults: Resource[] = [
  ['国家中小学智慧教育平台', '课程教学与教师研修', 'https://basic.smartedu.cn/'],
  ['江西省智慧教育平台', '本省教育资源与服务', 'https://www.jx.smartedu.cn/'],
  ['希沃 AI 教学空间', '教学工具与备课资源', 'https://www.seewo.com/product/common/JXKJ'],
  ['豆包', '备课思路与文案辅助', 'https://www.doubao.com/chat/'],
  ['DeepSeek', '提问讨论与文本辅助', 'https://chat.deepseek.com/'],
  ['Kimi', '长文阅读与资料整理', 'https://www.kimi.com/'],
  ['飞象老师', '教学资源与辅助工具', 'https://www.feixianglaoshi.com/h5/'],
  ['学科网', '学科资料与试题资源', 'https://www.zxxk.com/'],
].map(([name = '', description = '', url = ''], index) => ({
  id: `default-${index}`,
  name,
  description,
  url,
  group: 'platform',
}));
const storageKey = 'class-manager-resource-links-v1';

export function ExternalResource({
  name,
  description,
  url,
  kind = 'book',
}: {
  name: string;
  description: string;
  url: string;
  kind?: 'book' | 'heart' | 'graduation';
}) {
  const [error, setError] = useState('');
  const Icon = kind === 'heart' ? Heart : kind === 'graduation' ? GraduationCap : BookOpen;
  return (
    <div className="external-resource">
      <span className="resource-icon">
        <Icon size={21} />
      </span>
      <strong>{name}</strong>
      <p>{description}</p>
      <button
        className="resource-open"
        onClick={() => {
          void window.classManager
            .openResourceLink({ url })
            .then((result) => setError(result.ok ? '' : result.error.message))
            .catch(() => setError('未能打开网站，请稍后重试。'));
        }}
      >
        打开官网 <ArrowUpRight size={14} />
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function ResourceHub() {
  const [resources, setResources] = useState<Resource[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (
        Array.isArray(value) &&
        value.length <= 100 &&
        value.every(
          (item) =>
            typeof item?.id === 'string' &&
            typeof item?.name === 'string' &&
            item.name.length <= 80 &&
            typeof item?.description === 'string' &&
            item.description.length <= 160 &&
            ['platform', 'listening', 'public'].includes(item.group) &&
            resourceLinkInput.safeParse({ url: item.url }).success,
        )
      )
        return value;
    } catch {
      /* Missing or invalid storage uses the official defaults. */
    }
    return defaults;
  });
  const [editing, setEditing] = useState<Resource>();
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (editing) dialog.current?.showModal();
  }, [editing]);
  const save = (next: Resource[]) => {
    if (next.length > 100) {
      setError('最多保存 100 个资源入口，请先移除不再使用的入口。');
      return false;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setResources(next);
      setError('');
      return true;
    } catch {
      setError('资源入口未能保存，请检查本机存储空间。');
      return false;
    }
  };
  const add = (group: Resource['group']) => {
    setError('');
    setEditing({ id: crypto.randomUUID(), group, name: '', description: '', url: 'https://' });
  };
  return (
    <div className="resource-hub" aria-label="教师备课入口">
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {(['platform', 'listening', 'public'] as const).map((group) => (
        <section className={`design-panel resource-group group-${group}`} key={group}>
          <header>
            <div>
              <h2>
                {group === 'platform' ? '资源平台' : group === 'listening' ? '听课资料' : '公开课'}
              </h2>
              <p>
                {group === 'platform'
                  ? '在平台官网登录，即可使用对应资源。'
                  : group === 'listening'
                    ? '添加听课记录，集中整理课堂观察。'
                    : '保存课例链接与自己的展示资料。'}
              </p>
            </div>
            <button onClick={() => add(group)}>
              <Plus size={15} />
              {group === 'platform' ? '添加平台' : group === 'listening' ? '添加资料' : '添加课例'}
            </button>
          </header>
          <div className="resource-grid">
            {resources
              .filter((item) => item.group === group)
              .map((item) => (
                <article className="resource-card" key={item.id}>
                  <button
                    className="resource-edit"
                    aria-label={`编辑 ${item.name}`}
                    onClick={() => {
                      setError('');
                      setEditing({ ...item });
                    }}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  <ExternalResource {...item} />
                </article>
              ))}
          </div>
          {!resources.some((item) => item.group === group) && (
            <p className="resource-empty">
              {group === 'listening' ? '还没有听课资料' : '还没有公开课资料'}
            </p>
          )}
        </section>
      ))}
      {editing && (
        <dialog className="resource-dialog" ref={dialog} onCancel={() => setEditing(undefined)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!resourceLinkInput.safeParse({ url: editing.url }).success) {
                setError('请输入不含账号密码的完整 HTTPS 网站地址。');
                return;
              }
              const exists = resources.some((item) => item.id === editing.id);
              const next = exists
                ? resources.map((item) => (item.id === editing.id ? editing : item))
                : [...resources, editing];
              if (save(next)) setEditing(undefined);
            }}
          >
            <header>
              <h2>
                {resources.some((item) => item.id === editing.id) ? '编辑资源入口' : '添加资源入口'}
              </h2>
              <button type="button" aria-label="关闭资源弹窗" onClick={() => setEditing(undefined)}>
                <X size={18} />
              </button>
            </header>
            <label>
              名称
              <input
                required
                maxLength={80}
                autoFocus
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </label>
            <label>
              网站地址
              <input
                required
                type="url"
                maxLength={2048}
                value={editing.url}
                onChange={(event) => setEditing({ ...editing, url: event.target.value })}
              />
            </label>
            <label>
              简短说明
              <input
                maxLength={160}
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
            </label>
            <p>保存网站入口后，点击“打开官网”在默认浏览器中使用。</p>
            {error && <p role="alert">{error}</p>}
            <footer>
              {resources.some((item) => item.id === editing.id) && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    if (save(resources.filter((item) => item.id !== editing.id)))
                      setEditing(undefined);
                  }}
                >
                  移除入口
                </button>
              )}
              <button type="button" onClick={() => setEditing(undefined)}>
                取消
              </button>
              <button className="primary" type="submit">
                保存入口
              </button>
            </footer>
          </form>
        </dialog>
      )}
    </div>
  );
}
