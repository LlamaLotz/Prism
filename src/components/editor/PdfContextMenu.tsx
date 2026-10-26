import {
  ClipboardPaste,
  Copy,
  Highlighter,
  Maximize2,
  MessageSquarePlus,
  Pencil,
  TextQuote,
  Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type PdfContextMenuState = {
  x: number;
  y: number;
  annotationId?: string;
  area: "page" | "annotation" | "field";
  editable: boolean;
  hasSelection: boolean;
  selectionText: string;
};

const EDGE_MARGIN = 8;

export function PdfContextMenu({
  menu,
  hasAnnotation,
  canQuote,
  onClose,
  onCopy,
  onPaste,
  onSelectAll,
  onHighlight,
  onAddPoint,
  onEditComment,
  onQuote,
  onDelete,
}: {
  menu: PdfContextMenuState;
  hasAnnotation: boolean;
  canQuote: boolean;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onHighlight: () => void;
  onAddPoint: () => void;
  onEditComment: () => void;
  onQuote: () => void;
  onDelete: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  // Clamp before paint so the menu never flashes off-screen near an edge.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setPos({
      left: Math.max(
        EDGE_MARGIN,
        Math.min(menu.x, window.innerWidth - el.offsetWidth - EDGE_MARGIN),
      ),
      top: Math.max(
        EDGE_MARGIN,
        Math.min(menu.y, window.innerHeight - el.offsetHeight - EDGE_MARGIN),
      ),
    });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      root.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <div
      ref={root}
      className="pdf-menu-surface pdf-context-menu"
      role="group"
      aria-label="PDF actions"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      // Keep the PDF selection / focused annotation field alive while a menu
      // item is clicked. Keyboard activation still works normally.
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        if (!items.length) return;
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "ArrowDown"
            ? (current + 1) % items.length
            : event.key === "ArrowUp"
              ? (current - 1 + items.length) % items.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : -1;
        if (next >= 0) {
          event.preventDefault();
          items[next]?.focus();
        }
      }}
    >
      <button
        type="button"
        className="pdf-menu-item"
        disabled={!menu.hasSelection}
        onClick={() => run(onCopy)}
      >
        <Copy aria-hidden="true" />
        Copy
      </button>
      <button
        type="button"
        className="pdf-menu-item"
        disabled={!menu.editable}
        title={
          menu.editable ? undefined : "Paste is only available in editable fields"
        }
        onClick={() => run(onPaste)}
      >
        <ClipboardPaste aria-hidden="true" />
        Paste
      </button>
      <button
        type="button"
        className="pdf-menu-item"
        onClick={() => run(onSelectAll)}
      >
        <Maximize2 aria-hidden="true" />
        Select All
      </button>
      {(hasAnnotation || (menu.area === "page" && menu.hasSelection)) && (
        <div className="pdf-menu-sep" />
      )}
      {menu.area === "page" && menu.hasSelection && (
        <button
          type="button"
          className="pdf-menu-item"
          onClick={() => run(onHighlight)}
        >
          <Highlighter aria-hidden="true" />
          Highlight selection
        </button>
      )}
      {menu.area === "page" && !hasAnnotation && (
        <button
          type="button"
          className="pdf-menu-item"
          onClick={() => run(onAddPoint)}
        >
          <MessageSquarePlus aria-hidden="true" />
          Add point comment
        </button>
      )}
      {hasAnnotation && (
        <>
          <button
            type="button"
            className="pdf-menu-item"
            onClick={() => run(onEditComment)}
          >
            <Pencil aria-hidden="true" />
            Edit comment
          </button>
          <button
            type="button"
            className="pdf-menu-item"
            disabled={!canQuote}
            title={canQuote ? undefined : "Select a note first"}
            onClick={() => run(onQuote)}
          >
            <TextQuote aria-hidden="true" />
            Insert quote into note
          </button>
          <button
            type="button"
            className="pdf-menu-item is-danger"
            onClick={() => run(onDelete)}
          >
            <Trash2 aria-hidden="true" />
            Delete annotation
          </button>
        </>
      )}
    </div>
  );
}
