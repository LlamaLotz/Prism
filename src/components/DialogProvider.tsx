import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { X, AlertCircle, AlertTriangle, Type } from 'lucide-react';

// Prism's own dialog system — replaces the native window.alert / confirm /
// prompt everywhere. The provider keeps a FIFO queue of requests (so dialogs
// never clobber each other) and renders one themed modal at a time. The hook
// mirrors the native signatures: `alert` resolves when dismissed, `confirm`
// resolves with the user's choice, `prompt` resolves with the entered text or
// null when cancelled.

interface AlertOptions {
  title?: string;
}
interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red danger styling for destructive actions (delete, restore). */
  danger?: boolean;
}
interface PromptOptions {
  title?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}

interface DialogContextValue {
  alert: (message: string, opts?: AlertOptions) => Promise<void>;
  confirm: (message: string, opts?: ConfirmOptions) => Promise<boolean>;
  prompt: (message: string, opts?: PromptOptions) => Promise<string | null>;
}

type DialogRequest =
  | {
      id: number;
      kind: 'alert';
      message: string;
      title?: string;
      resolve: () => void;
    }
  | {
      id: number;
      kind: 'confirm';
      message: string;
      title?: string;
      confirmLabel?: string;
      cancelLabel?: string;
      danger?: boolean;
      resolve: (value: boolean) => void;
    }
  | {
      id: number;
      kind: 'prompt';
      message: string;
      title?: string;
      initialValue?: string;
      placeholder?: string;
      confirmLabel?: string;
      resolve: (value: string | null) => void;
    };

const DialogContext = createContext<DialogContextValue | null>(null);

export const useDialog = (): DialogContextValue => {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useDialog must be used inside <DialogProvider>');
  }
  return ctx;
};

let nextId = 1;

export const DialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [queue, setQueue] = useState<DialogRequest[]>([]);

  const current = queue[0] ?? null;

  const dismissCurrent = useCallback((resolve: (value?: any) => void, value?: any) => {
    setQueue((q) => {
      const [head, ...rest] = q;
      if (!head) return q;
      // Resolve AFTER the state update so the modal unmounts cleanly before
      // the caller's continuation runs.
      queueMicrotask(() => resolve(value));
      return rest;
    });
  }, []);

  const alert = useCallback(
    (message: string, opts?: AlertOptions): Promise<void> =>
      new Promise((resolve) => {
        setQueue((q) => [
          ...q,
          { id: nextId++, kind: 'alert', message, title: opts?.title, resolve },
        ]);
      }),
    []
  );

  const confirm = useCallback(
    (message: string, opts?: ConfirmOptions): Promise<boolean> =>
      new Promise((resolve) => {
        setQueue((q) => [
          ...q,
          {
            id: nextId++,
            kind: 'confirm',
            message,
            title: opts?.title,
            confirmLabel: opts?.confirmLabel,
            cancelLabel: opts?.cancelLabel,
            danger: opts?.danger,
            resolve,
          },
        ]);
      }),
    []
  );

  const prompt = useCallback(
    (message: string, opts?: PromptOptions): Promise<string | null> =>
      new Promise((resolve) => {
        setQueue((q) => [
          ...q,
          {
            id: nextId++,
            kind: 'prompt',
            message,
            title: opts?.title,
            initialValue: opts?.initialValue,
            placeholder: opts?.placeholder,
            confirmLabel: opts?.confirmLabel,
            resolve,
          },
        ]);
      }),
    []
  );

  const value: DialogContextValue = { alert, confirm, prompt };

  return (
    <DialogContext.Provider value={value}>
      {children}
      {current && <DialogModal key={current.id} request={current} dismiss={dismissCurrent} />}
    </DialogContext.Provider>
  );
};

const DialogModal: React.FC<{
  request: DialogRequest;
  dismiss: (resolve: (value?: any) => void, value?: any) => void;
}> = ({ request, dismiss }) => {
  const [promptValue, setPromptValue] = useState(request.kind === 'prompt' ? (request.initialValue ?? '') : '');
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const isDanger = request.kind === 'confirm' && !!request.danger;
  const title =
    request.title ??
    (request.kind === 'alert' ? 'Notice' : request.kind === 'confirm' ? 'Please confirm' : 'Enter a value');
  const confirmLabel =
    (request.kind === 'confirm' || request.kind === 'prompt') && request.confirmLabel
      ? request.confirmLabel
      : 'OK';

  const beginClose = (value?: any) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      dismiss(request.resolve, value);
    }, 120);
  };

  const handleConfirm = () => {
    if (request.kind === 'alert') beginClose();
    else if (request.kind === 'confirm') beginClose(true);
    else beginClose(promptValue);
  };

  const handleCancel = () => {
    if (request.kind === 'alert') beginClose();
    else beginClose(request.kind === 'confirm' ? false : null);
  };

  // showModal() gives us top-layer rendering, background inertness, focus
  // containment, and native Escape handling. Focus the safe primary control
  // explicitly; destructive confirms default to Cancel.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const focusTimer = window.setTimeout(() => {
      if (request.kind === 'prompt') inputRef.current?.focus();
      else if (isDanger) cancelBtnRef.current?.focus();
      else confirmBtnRef.current?.focus();
    }, 30);
    return () => {
      window.clearTimeout(focusTimer);
      if (dialog.isConnected && dialog.open) dialog.close();
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  const Icon = request.kind === 'alert' ? AlertCircle : request.kind === 'confirm' ? AlertTriangle : Type;

  return (
    <dialog
      ref={dialogRef}
      className="dialog-root backdrop-blur-sm"
      role={request.kind === 'alert' || isDanger ? 'alertdialog' : undefined}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-closing={closing}
      onCancel={(event) => {
        event.preventDefault();
        handleCancel();
      }}
      onMouseDown={(event) => {
        // Backdrop click = cancel (safe default for destructive actions).
        if (event.button === 0 && event.target === event.currentTarget) handleCancel();
      }}
    >
      <div className="dialog-panel w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`p-1.5 rounded-md shrink-0 ${
                isDanger
                  ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                  : request.kind === 'alert'
                    ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
                    : 'bg-brand-500/10 border border-brand-500/20 text-brand-400'
              }`}
            >
              <Icon className="w-4 h-4" />
            </div>
            <h3 id={titleId} className="text-sm font-semibold text-neutral-100 truncate">{title}</h3>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="p-1 text-neutral-500 hover:text-red-400 hover:bg-neutral-800 rounded-md transition-colors shrink-0"
            title="Dismiss (Esc)"
            aria-label="Dismiss dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <p id={descriptionId} className="text-[13px] leading-relaxed text-neutral-300 whitespace-pre-wrap break-words">
            {request.message}
          </p>
          {request.kind === 'prompt' && (
            <input
              ref={inputRef}
              aria-label={title}
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirm();
              }}
              placeholder={request.placeholder}
              className="mt-3 w-full px-3 py-2 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-brand-500/60 focus:ring-1 focus:ring-brand-500/30 transition-colors select-text"
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-neutral-800 flex items-center justify-end gap-2 bg-neutral-950/40">
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={handleCancel}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            {request.kind === 'confirm' && request.cancelLabel ? request.cancelLabel : 'Cancel'}
          </button>
          <button
            ref={request.kind !== 'prompt' ? confirmBtnRef : undefined}
            type="button"
            onClick={handleConfirm}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              isDanger
                ? 'bg-red-500 text-white hover:bg-red-400'
                : 'bg-brand-500 text-[color:var(--color-brand-contrast)] font-semibold hover:bg-brand-400'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
};
