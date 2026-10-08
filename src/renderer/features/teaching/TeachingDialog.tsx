import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function TeachingDialog({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="tw-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button type="button" aria-label="关闭窗口" disabled={busy} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
