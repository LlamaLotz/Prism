import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/**
 * Keeps keyboard focus inside a modal surface and restores it to the trigger
 * when the surface closes. Native <dialog> gets this behavior for free; this
 * hook covers page-sized modals such as Settings that cannot use showModal().
 */
export function useDialogFocus<T extends HTMLElement>(active: boolean, restoreFocus = true) {
  const containerRef = useRef<T | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const getFocusable = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
        if (element.matches(':disabled') || element.getAttribute('aria-hidden') === 'true') {
          return false;
        }
        const style = window.getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        );
      });

    const focusTimer = window.setTimeout(() => {
      // Do not steal focus from a nested modal that has already focused itself.
      if (container.contains(document.activeElement)) return;
      const preferred = container.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? getFocusable()[0] ?? container).focus();
    }, 30);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);

      // The initial focus target (e.g. a tabindex="-1" heading) is not in the
      // tab order. Treat it like a boundary so Tab cannot escape the modal.
      if (currentIndex === -1) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && currentIndex === 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      container.removeEventListener('keydown', onKeyDown);
      if (restoreFocus && previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    };
  }, [active, restoreFocus]);

  return containerRef;
}
