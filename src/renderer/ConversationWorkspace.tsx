import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Plus, Search, Pencil, Trash2, X } from 'lucide-react';
import type { Snapshot } from '../shared/contracts';
import type { BusinessView } from '../shared/conversation';
import type {
  ConversationHistory,
  ConversationHistoryState,
  ConversationHistorySummary,
} from '../shared/conversation-history';
import { ConversationPage } from './ConversationPage';

export function ConversationWorkspace({
  snapshot,
  onSnapshot,
  onNavigate,
  onDirtyChange,
  mode,
  active,
  newRequest,
  onOpen,
  restoreNotice,
  onRestoreNotice,
}: {
  snapshot: Snapshot;
  onSnapshot: (value: Snapshot) => void;
  onNavigate: (view: BusinessView) => void;
  onDirtyChange: (dirty: boolean) => void;
  mode: 'conversation' | 'sessions';
  active: boolean;
  newRequest: number;
  onOpen: () => void;
  restoreNotice: string;
  onRestoreNotice: (value: string) => void;
}) {
  const api = window.classManager;
  const [record, setRecord] = useState<ConversationHistory>();
  const [catalog, setCatalog] = useState<ConversationHistorySummary[]>([]);
  const [working, setWorking] = useState(false),
    [changing, setChanging] = useState(false);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<{
    kind: 'rename' | 'delete';
    item: ConversationHistorySummary;
  }>();
  const [title, setTitle] = useState('');
  const generation = useRef(0),
    revision = useRef(1);
  const current = useRef<ConversationHistory | undefined>(undefined);
  const wanted = useRef<ConversationHistory | undefined>(undefined);
  const pump = useRef<Promise<boolean> | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seenRequest = useRef(newRequest);
  const summarize = (item: ConversationHistory): ConversationHistorySummary => {
    const { state, ...metadata } = item;
    return {
      ...metadata,
      archived: item.epoch !== snapshot.epoch,
      messageCount: state.messages.length,
      preview: state.messages.at(-1)?.text.slice(0, 100) ?? state.draft.slice(0, 100),
    };
  };
  const select = (item: ConversationHistory) => {
    current.current = item;
    revision.current = item.revision;
    wanted.current = undefined;
    setRecord(item);
    setError('');
  };
  function updateHistory(update: (state: ConversationHistoryState) => ConversationHistoryState) {
    const item = current.current;
    if (!item || item.epoch !== snapshot.epoch) return;
    const next = { ...item, state: update(item.state) };
    current.current = next;
    wanted.current = next;
    setRecord(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 250);
  }
  async function refresh() {
    const result = await api.listConversationHistory({ epoch: snapshot.epoch });
    if (!result.ok) throw Error(result.error.message);
    setCatalog(result.value);
    return result.value;
  }
  async function flush(): Promise<boolean> {
    if (timer.current) clearTimeout(timer.current);
    if (pump.current) return pump.current;
    const version = generation.current;
    const running = (async () => {
      setSaving(true);
      try {
        while (wanted.current && version === generation.current) {
          const value = wanted.current;
          wanted.current = undefined;
          let result;
          try {
            result = await api.saveConversationHistory({
              epoch: value.epoch,
              id: value.id,
              expectedRevision: revision.current,
              state: value.state,
            });
          } catch (failure) {
            if (version === generation.current) wanted.current ??= value;
            throw failure;
          }
          if (version !== generation.current) return false;
          if (!result.ok) {
            wanted.current ??= value;
            setError(`会话尚未保存：${result.error.message}`);
            return false;
          }
          revision.current = result.value.revision;
          setCatalog((old) => [
            summarize(result.value),
            ...old.filter((item) => item.id !== value.id),
          ]);
        }
        setError('');
        return true;
      } catch {
        setError('会话尚未保存，请点击重试。');
        return false;
      } finally {
        if (version === generation.current) setSaving(false);
      }
    })();
    pump.current = running;
    try {
      return await running;
    } finally {
      if (pump.current === running) pump.current = undefined;
    }
  }
  useEffect(() => {
    const version = ++generation.current;
    wanted.current = undefined;
    pump.current = undefined;
    current.current = undefined;
    if (timer.current) clearTimeout(timer.current);
    setRecord(undefined);
    setSaving(false);
    setChanging(true);
    void (async () => {
      try {
        const listed = await api.listConversationHistory({ epoch: snapshot.epoch });
        if (!listed.ok) throw Error(listed.error.message);
        const recent = listed.value.find((item) => !item.archived);
        const result = recent
          ? await api.readConversationHistory({ epoch: snapshot.epoch, id: recent.id })
          : await api.createConversationHistory({ epoch: snapshot.epoch });
        if (!result.ok) throw Error(result.error.message);
        if (version !== generation.current) return;
        setCatalog([
          summarize(result.value),
          ...listed.value.filter((item) => item.id !== result.value.id),
        ]);
        select(result.value);
      } catch (failure) {
        if (version === generation.current)
          setError(failure instanceof Error ? failure.message : '会话读取失败，请重新打开应用。');
      } finally {
        if (version === generation.current) setChanging(false);
      }
    })();
    return () => {
      generation.current++;
      if (timer.current) clearTimeout(timer.current);
    };
    // Reload only for a workspace replacement; normal snapshot refreshes preserve the current conversation.
  }, [api, snapshot.epoch]);
  useEffect(() => {
    return api.onConversationHistoryClose(async () => flush());
  }, [api, snapshot.epoch]);
  useEffect(() => {
    onDirtyChange(working || changing);
    return () => onDirtyChange(false);
  }, [working, changing, onDirtyChange]);
  async function open(id: string) {
    if (working || changing) return;
    setChanging(true);
    try {
      if (!(await flush())) return;
      const result = await api.readConversationHistory({ epoch: snapshot.epoch, id });
      if (!result.ok) throw Error(result.error.message);
      select(result.value);
      onOpen();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '会话读取失败。');
    } finally {
      setChanging(false);
    }
  }
  async function create() {
    if (working || changing) return;
    setChanging(true);
    try {
      if (!(await flush())) return;
      const result = await api.createConversationHistory({ epoch: snapshot.epoch });
      if (!result.ok) throw Error(result.error.message);
      select(result.value);
      await refresh();
      onOpen();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '新会话创建失败。');
    } finally {
      setChanging(false);
    }
  }
  useEffect(() => {
    if (newRequest === seenRequest.current) return;
    seenRequest.current = newRequest;
    void create();
  }, [newRequest]);
  async function confirmDialog() {
    if (!dialog || working || changing) return;
    setChanging(true);
    try {
      if (!(await flush())) return;
      const existing = await api.readConversationHistory({
        epoch: snapshot.epoch,
        id: dialog.item.id,
      });
      if (!existing.ok) throw Error(existing.error.message);
      const input = {
        epoch: snapshot.epoch,
        id: existing.value.id,
        expectedRevision: existing.value.revision,
      };
      if (dialog.kind === 'rename') {
        const renamed = await api.renameConversationHistory({ ...input, title });
        if (!renamed.ok) throw Error(renamed.error.message);
        if (record?.id === input.id) select(renamed.value);
        await refresh();
      } else {
        const deleted = await api.deleteConversationHistory(input);
        if (!deleted.ok) throw Error(deleted.error.message);
        const remaining = await refresh();
        if (record?.id === input.id) {
          const next = remaining.find((item) => !item.archived);
          const result = next
            ? await api.readConversationHistory({ epoch: snapshot.epoch, id: next.id })
            : await api.createConversationHistory({ epoch: snapshot.epoch });
          if (!result.ok) throw Error(result.error.message);
          select(result.value);
          await refresh();
        }
      }
      setDialog(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '会话操作未完成。');
    } finally {
      setChanging(false);
    }
  }
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          <span>{error}</span>
          <button disabled={changing || saving} onClick={() => void flush()}>
            重试保存
          </button>
        </div>
      )}
      <div hidden={mode !== 'sessions'}>
        <section className="session-manager" aria-label="会话管理">
          <div className="session-toolbar">
            <p>找回之前的讨论，接着处理教学事务。聊天记录保存在本机。</p>
            <button
              className="primary"
              disabled={working || changing}
              onClick={() => void create()}
            >
              <Plus size={16} />
              新建会话
            </button>
          </div>
          <label className="session-search">
            <Search size={17} />
            <input
              aria-label="搜索会话"
              placeholder="搜索标题或最近消息"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="session-list">
            {catalog
              .filter((item) => `${item.title} ${item.preview}`.includes(search.trim()))
              .map((item) => (
                <article
                  className={`session-item ${item.id === record?.id ? 'current' : ''}`}
                  key={item.id}
                  aria-label={item.title}
                >
                  <MessageSquare size={20} />
                  <div className="session-description">
                    <h3>{item.title}</h3>
                    <p>{item.preview || '开始一段新的讨论'}</p>
                    <small>
                      {new Date(item.updatedAt).toLocaleString('zh-CN')} · {item.messageCount}条消息{' '}
                      {item.archived
                        ? ' · 恢复前的记录'
                        : item.id === record?.id
                          ? ' · 当前会话'
                          : ''}
                    </small>
                  </div>
                  <div className="session-item-actions">
                    <button disabled={working || changing} onClick={() => void open(item.id)}>
                      {item.archived ? '查看记录' : '继续对话'}
                    </button>
                    <button
                      aria-label={`重命名 ${item.title}`}
                      disabled={working || changing}
                      onClick={() => {
                        setTitle(item.title);
                        setDialog({ kind: 'rename', item });
                      }}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      aria-label={`删除 ${item.title}`}
                      disabled={working || changing}
                      onClick={() => setDialog({ kind: 'delete', item })}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              ))}
          </div>
          {!catalog.some((item) => `${item.title} ${item.preview}`.includes(search.trim())) && (
            <p className="empty-state">没有找到会话，换个关键词试试。</p>
          )}
        </section>
      </div>
      <div hidden={mode !== 'conversation'}>
        {record ? (
          <ConversationPage
            key={record.id}
            snapshot={snapshot}
            onSnapshot={onSnapshot}
            onNavigate={onNavigate}
            onDirtyChange={setWorking}
            active={active && mode === 'conversation'}
            restoreNotice={restoreNotice}
            onRestoreNotice={onRestoreNotice}
            history={record}
            title={catalog.find((item) => item.id === record.id)?.title ?? record.title}
            locked={changing}
            onHistoryChange={updateHistory}
            onNewConversation={() => void create()}
          />
        ) : (
          <p role="status">正在读取会话…</p>
        )}
      </div>
      {dialog && (
        <SessionDialog
          title={dialog.kind === 'rename' ? '重命名会话' : '删除会话'}
          busy={changing}
          onClose={() => setDialog(undefined)}
        >
          <header className="dialog-header">
            <h2>{dialog.kind === 'rename' ? '重命名会话' : '删除会话'}</h2>
            <button
              aria-label="关闭会话弹窗"
              disabled={changing}
              onClick={() => setDialog(undefined)}
            >
              <X size={18} />
            </button>
          </header>
          {dialog.kind === 'rename' ? (
            <label className="session-dialog-label">
              会话名称
              <input
                autoFocus
                maxLength={80}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          ) : (
            <p>删除“{dialog.item.title}”的聊天记录？班级资料、课时和已完成的业务操作会保留。</p>
          )}
          <footer className="dialog-actions">
            <button disabled={changing} onClick={() => setDialog(undefined)}>
              取消
            </button>
            <button
              className={dialog.kind === 'delete' ? 'danger' : 'primary'}
              disabled={changing || (dialog.kind === 'rename' && !title.trim())}
              onClick={() => void confirmDialog()}
            >
              {dialog.kind === 'rename' ? '保存名称' : '删除会话'}
            </button>
          </footer>
        </SessionDialog>
      )}
    </>
  );
}

function SessionDialog({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
