import { useEffect, useRef, type ReactNode } from 'react';
import { Maximize2, MessageSquare, Minimize2, Sparkles, X } from 'lucide-react';

/** One persistent workspace: minimising changes visibility, never task ownership. */
export function FloatingAssistant({
  open,
  expanded,
  working,
  context,
  onOpen,
  onClose,
  onExpand,
  children,
}: {
  open: boolean;
  expanded: boolean;
  working: boolean;
  context: string;
  onOpen: () => void;
  onClose: () => void;
  onExpand: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const previous = useRef(open);
  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => {
        const input = panel.current?.querySelector<HTMLTextAreaElement>('#conversation-input');
        if (input && !input.disabled && !input.closest('[hidden]')) input.focus();
        else panel.current?.focus();
      });
      previous.current = true;
      return () => cancelAnimationFrame(frame);
    }
    if (previous.current) launcher.current?.focus();
    previous.current = false;
  }, [open]);
  return (
    <>
      <section
        ref={panel}
        className={`assistant-surface ${expanded ? 'expanded' : 'compact'}`}
        hidden={!open}
        role="dialog"
        aria-modal="false"
        aria-labelledby="assistant-window-title"
        id="assistant-window"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="assistant-window-header">
          <span className="assistant-avatar">
            <Sparkles size={20} />
          </span>
          <div>
            <h2 id="assistant-window-title">业务助手</h2>
            <small>陪你处理{context} · 收起后保留对话</small>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={expanded ? '缩小对话窗口' : '展开对话窗口'}
            title={expanded ? '缩小对话窗口' : '展开对话窗口'}
            onClick={onExpand}
          >
            {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="收起对话窗口"
            title="收起对话（保留任务与草稿）"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="assistant-window-body">{children}</div>
      </section>
      <button
        type="button"
        ref={launcher}
        className={`assistant-capsule ${working ? 'working' : ''}`}
        aria-label={open ? '收起智能对话小窗' : '打开智能对话小窗'}
        aria-expanded={open}
        aria-controls="assistant-window"
        onClick={open ? onClose : onOpen}
      >
        <MessageSquare size={20} />
        <span>智能对话{working && <small>任务处理中 · 点击查看</small>}</span>
        <span className="assistant-capsule-dot" aria-hidden="true" />
      </button>
    </>
  );
}
