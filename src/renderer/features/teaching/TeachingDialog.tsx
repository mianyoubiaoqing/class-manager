import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
const CloseContext = createContext<() => void>(() => {});
export function TeachingDialogCancel({
  children = '取消',
  disabled = false,
}: {
  children?: ReactNode;
  disabled?: boolean;
}) {
  const close = useContext(CloseContext);
  return (
    <button type="button" disabled={disabled} onClick={close}>
      {children}
    </button>
  );
}
export function TeachingDialog({
  title,
  children,
  onClose,
  busy = false,
  dirty,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  dirty?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const descriptionId = useId();
  const [changed, setChanged] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const continueButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const close = () => {
    if (busy) return;
    if (dirty ?? changed) {
      previousFocus.current = document.activeElement as HTMLElement;
      setConfirmClose(true);
    } else onClose();
  };
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  useEffect(() => {
    if (confirmClose) continueButton.current?.focus();
    else previousFocus.current?.focus();
  }, [confirmClose]);
  return (
    <dialog
      ref={ref}
      className="tw-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (confirmClose) setConfirmClose(false);
        else close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button type="button" aria-label="关闭窗口" disabled={busy} onClick={close}>
          <X size={18} />
        </button>
      </header>
      {confirmClose && (
        <section role="alertdialog" aria-label="放弃未保存内容？" aria-describedby={descriptionId}>
          <h3>放弃未保存内容？</h3>
          <p id={descriptionId}>关闭后，尚未保存的输入将丢失。</p>
          <footer>
            <button ref={continueButton} type="button" onClick={() => setConfirmClose(false)}>
              继续编辑
            </button>
            <button type="button" className="danger" onClick={onClose}>
              放弃修改并关闭
            </button>
          </footer>
        </section>
      )}
      <fieldset
        className="tw-dialog-body"
        disabled={busy || confirmClose}
        hidden={confirmClose}
        onChange={() => setChanged(true)}
      >
        <CloseContext.Provider value={close}>{children}</CloseContext.Provider>
      </fieldset>
    </dialog>
  );
}
