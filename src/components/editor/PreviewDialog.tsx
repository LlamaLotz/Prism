import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface PreviewDialogProps {
  title: string;
  /** Screen-reader description of what this preview is for. */
  description: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  /** Extra class on the panel, for width differences between previews. */
  panelClassName?: string;
  /** Trigger that should regain focus after the dialog closes. */
  returnFocus?: HTMLElement | null;
}

/**
 * Shared modal shell for the format/split previews. Native <dialog> provides
 * top-layer rendering, focus containment and Escape handling; we add the same
 * scrim/enter-exit animation and focus restoration used by DialogProvider.
 */
export const PreviewDialog: React.FC<PreviewDialogProps> = ({
  title,
  description,
  onClose,
  children,
  footer,
  panelClassName = '',
  returnFocus = null,
}) => {
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closingRef.current = false;
      onCloseRef.current();
    }, 120);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    previousFocusRef.current =
      returnFocus && returnFocus.isConnected
        ? returnFocus
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    if (!dialog.open) dialog.showModal();
    // Focus the dialog itself so the screen reader announces its labelled
    // title and description before the user tabs into the controls. Native
    // <dialog> keeps focus inside the modal.
    const focusTimer = window.setTimeout(() => dialog.focus(), 20);
    return () => {
      window.clearTimeout(focusTimer);
      if (dialog.isConnected && dialog.open) dialog.close();
      const previous = previousFocusRef.current;
      const active = document.activeElement;
      if (
        previous &&
        previous !== document.body &&
        previous.isConnected &&
        (!active || active === document.body || dialog.contains(active))
      ) {
        previous.focus();
      }
    };
  }, []);

  useEffect(
    () => () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    },
    []
  );

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      className="dialog-root backdrop-blur-sm"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-closing={closing}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        tabIndex={-1}
        className={`dialog-panel structure-dialog ${panelClassName} bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden flex flex-col`}
      >
        <div className="structure-dialog__header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            onClick={requestClose}
            className="structure-dialog__close"
            title="Close (Esc)"
            aria-label="Close dialog"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <p id={descriptionId} className="sr-only">
          {description}
        </p>
        <div className="structure-dialog__body">{children}</div>
        <div className="structure-dialog__footer">{footer}</div>
      </div>
    </dialog>
  );
};
