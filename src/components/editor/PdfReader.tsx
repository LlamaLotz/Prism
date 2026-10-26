import {
  Check,
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  Highlighter,
  Loader2,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  RotateCw,
  Save,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import "./pdf-text-layer.css";
import { validAnnotationDraft } from "./annotationDraft";
import {
  research,
  type ResearchAsset,
  type PdfAnnotation,
  type PdfRequest,
  type AnnotationFile,
} from "../../services/research";
import { useDialog } from "../DialogProvider";
import {
  PdfContextMenu,
  type PdfContextMenuState,
} from "./PdfContextMenu";
GlobalWorkerOptions.workerSrc = workerUrl;
const colors: Record<string, string> = {
  yellow: "#f5d442",
  green: "#4bc882",
  blue: "#65a8f5",
  pink: "#f68bcc",
};

function ColorSwatches({
  color,
  change,
  label,
}: {
  color: string;
  change: (color: string) => void;
  label: string;
}) {
  return (
    <div className="pdf-color-swatches" role="group" aria-label={label}>
      {Object.entries(colors).map(([name, value]) => (
        <button
          key={name}
          type="button"
          className="pdf-icon-button pdf-color-swatch-button"
          aria-label={name}
          title={name}
          aria-pressed={name === color}
          onClick={() => change(name)}
        >
          <span
            className="pdf-color-swatch"
            style={{ backgroundColor: value }}
          >
            {name === color && <Check size={14} color="#111" />}
          </span>
        </button>
      ))}
    </div>
  );
}

function ColorPicker({
  color,
  change,
  label,
}: {
  color: string;
  change: (color: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return (
    <div
      ref={root}
      className="pdf-color-picker"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="pdf-icon-button"
        aria-label={`${label}: ${color}`}
        title={`${label}: ${color}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span
          className="pdf-color-swatch"
          style={{ backgroundColor: colors[color] ?? colors.yellow }}
        />
      </button>
      {open && (
        <div
          className="pdf-color-palette"
          role="group"
          aria-label={label}
        >
          {Object.entries(colors).map(([name, value]) => (
            <button
              key={name}
              type="button"
              className="pdf-icon-button pdf-color-swatch-button"
              aria-label={name}
              title={name}
              aria-pressed={name === color}
              onClick={() => {
                change(name);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span
                className="pdf-color-swatch"
                style={{ backgroundColor: value }}
              >
                {name === color && <Check size={14} color="#111" />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PdfToolbarMenu({
  id,
  label,
  icon,
  triggerRef,
  open,
  setOpen,
  children,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  setOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      root.current
        ?.querySelector<HTMLButtonElement>(
          ".pdf-menu-surface button:not(:disabled)",
        )
        ?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, triggerRef]);
  return (
    <div ref={root} className="pdf-menu">
      <button
        ref={triggerRef}
        type="button"
        className="pdf-icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </button>
      {open && (
        <div
          id={id}
          className="pdf-menu-surface"
          role="group"
          aria-label={label}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setOpen(false);
          }}
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
          {children}
        </div>
      )}
    </div>
  );
}

type SelectionPart = {
  page: number;
  rects: [number, number, number, number][];
  text: string;
};

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function PdfReader({
  request,
  notePath,
  close,
  dirtyChanged,
  vaultPath,
  blocked,
  registerDiscard,
}: {
  blocked: boolean;
  registerDiscard: (fn: () => void) => void;
  vaultPath: string;
  request: PdfRequest;
  notePath?: string;
  close: () => void;
  dirtyChanged: (v: boolean) => void;
}) {
  const { confirm } = useDialog();
  const [annotationsOpen, setAnnotationsOpen] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [invalidDraft, setInvalidDraft] = useState<string | null>(null);
  const draftKey = (id: string) =>
    `prism_pdf_draft:${encodeURIComponent(vaultPath)}:${id}`;
  const [asset, setAsset] = useState<ResearchAsset | null>(null),
    [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState("");
  const [file, setFile] = useState<AnnotationFile | null>(null),
    [entries, setEntries] = useState<PdfAnnotation[]>([]),
    [dirty, setDirty] = useState(false);
  const [savePhase, setSavePhase] = useState<"idle" | "saving" | "failed">(
    "idle",
  );
  const [page, setPage] = useState(request.page ?? 1),
    [scale, setScale] = useState(1),
    [rotation, setRotation] = useState(0),
    [selected, setSelected] = useState(request.annotation ?? "");
  const [selection, setSelection] = useState<SelectionPart[]>([]),
    [pointMode, setPointMode] = useState(false),
    [color, setColor] = useState("yellow");
  const [query, setQuery] = useState(""),
    [matches, setMatches] = useState<number[]>([]),
    [searching, setSearching] = useState(false),
    [searchDone, setSearchDone] = useState(false),
    [searchOpen, setSearchOpen] = useState(false);
  const [penOpen, setPenOpen] = useState(false),
    [moreOpen, setMoreOpen] = useState(false);
  const [contextMenu, setContextMenu] =
    useState<PdfContextMenuState | null>(null);
  const [attempt, setAttempt] = useState(0),
    [relink, setRelink] = useState(false),
    [password, setPassword] = useState("");
  const passwordCallback = useRef<((value: string) => void) | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const pages = useRef<HTMLDivElement>(null),
    viewports = useRef(
      new Map<number, ReturnType<PDFPageProxy["getViewport"]>>(),
    );
  const searchRun = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const findTrigger = useRef<HTMLButtonElement>(null);
  const penTrigger = useRef<HTMLButtonElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const currentEntries = useRef(entries);
  const changeVersion = useRef(0);
  const savingRef = useRef(false);
  const contextEditable = useRef<HTMLInputElement | HTMLTextAreaElement | null>(
    null,
  );
  const contextFieldRange = useRef<{ start: number; end: number } | null>(
    null,
  );
  currentEntries.current = entries;
  useEffect(() => {
    dirtyChanged(dirty);
  }, [dirty, dirtyChanged]);
  useEffect(() => {
    registerDiscard(() => {
      if (asset?.documentId)
        localStorage.removeItem(draftKey(asset.documentId));
    });
  }, [asset, registerDiscard, vaultPath]);
  useEffect(() => {
    let alive = true,
      opened: ResearchAsset | null = null,
      task: ReturnType<typeof getDocument> | null = null;
    setError("");
    setPdf(null);
    setAsset(null);
    setFile(null);
    setInvalidDraft(null);
    setNeedsPassword(false);
    setSearchOpen(false);
    setPenOpen(false);
    setMoreOpen(false);
    setContextMenu(null);
    setSavePhase("idle");
    setDirty(false);
    passwordCallback.current = null;
    viewports.current.clear();
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!alive) return;
      try {
        opened = await research.open(request, relink);
      } finally {
        if (alive) setRelink(false);
      }
      if (!opened) {
        if (alive) close();
        return;
      }
      if (!alive) {
        void research.close(opened.handle);
        return;
      }
      setAsset(opened);
      const a = opened;
      const range = new (class extends PDFDataRangeTransport {
        stopped = false;
        requestDataRange(begin: number, end: number) {
          void (async () => {
            for (let offset = begin; offset < end; offset += 1024 * 1024) {
              const bytes = await research.read(
                a.handle,
                offset,
                Math.min(1024 * 1024, end - offset),
              );
              if (!this.stopped) this.onDataRange(offset, bytes);
            }
          })().catch((e) => {
            if (alive) setError(String(e));
          });
        }
        abort() {
          this.stopped = true;
        }
      })(a.size, null, true);
      task = getDocument({
        range,
        rangeChunkSize: 256 * 1024,
        disableAutoFetch: true,
        disableStream: true,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/",
        iccUrl: "/pdfjs/iccs/",
      });
      task.onPassword = (callback: (password: string) => void) => {
        if (alive) {
          passwordCallback.current = callback;
          setNeedsPassword(true);
        }
      };
      const [doc, annotations] = await Promise.all([
        task.promise,
        research.annotations(a),
      ]);
      if (!alive) return;
      setPdf(doc);
      setFile(annotations);
      setEntries(annotations.entries);
      setDirty(false);
      setSavePhase("idle");
      changeVersion.current = 0;
      try {
        const raw = localStorage.getItem(draftKey(a.documentId!));
        if (raw) {
          setInvalidDraft(raw);
          const draft = JSON.parse(raw) as AnnotationFile;
          if (validAnnotationDraft(draft, a.documentId!, doc.numPages)) {
            setInvalidDraft(null);
            setEntries(draft.entries);
            setFile({ ...annotations, revision: draft.revision });
            setDirty(true);
            setError(
              draft.revision === annotations.revision
                ? "Recovered unsaved annotations. Save to keep them."
                : "Recovered draft conflicts with saved annotations. Download the draft before reopening the saved version.",
            );
          } else {
            setError(
              "The recovery draft is invalid and was preserved. Reload saved annotations to continue.",
            );
          }
        }
      } catch {
        setError("Could not recover the local annotation draft.");
      }
      setPage(
        Math.min(
          doc.numPages,
          annotations.entries.find((a) => a.id === request.annotation)?.page ??
            request.page ??
            1,
        ),
      );
    })().catch((e) => {
      if (alive) setError(String(e));
    });
    return () => {
      alive = false;
      searchRun.current++;
      void task?.destroy();
      if (opened) void research.close(opened.handle);
    };
  }, [attempt]);
  const navigate = (n: number) => {
    const next = Math.max(1, Math.min(pdf?.numPages ?? 1, n));
    setPage(next);
    pages.current
      ?.querySelector(`[data-pdf-page="${next}"]`)
      ?.scrollIntoView({ block: "start" });
  };
  useEffect(() => {
    if (pdf) requestAnimationFrame(() => navigate(page));
  }, [pdf]);
  useEffect(() => {
    const container = pages.current;
    if (!pdf || !container) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const viewport = container.getBoundingClientRect();
      let best = 0, visible = 0, distance = Infinity;
      container.querySelectorAll<HTMLElement>("[data-pdf-page]").forEach(element => {
        const rect = element.getBoundingClientRect();
        const height = Math.max(0, Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top));
        const offset = Math.abs(rect.top - viewport.top);
        if (height > visible || (height > 0 && height === visible && offset < distance)) {
          best = Number(element.dataset.pdfPage); visible = height; distance = offset;
        }
      });
      if (best) setPage(best);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    container.querySelectorAll("[data-pdf-page]").forEach(element => observer.observe(element));
    container.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => { observer.disconnect(); container.removeEventListener("scroll", schedule); cancelAnimationFrame(frame); };
  }, [pdf, scale, rotation]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setPenOpen(false);
    setMoreOpen(false);
    setContextMenu(null);
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    requestAnimationFrame(() => findTrigger.current?.focus());
  }, []);
  const setPenMenu = useCallback((open: boolean) => {
    setPenOpen(open);
    if (open) setMoreOpen(false);
  }, []);
  const setMoreMenu = useCallback((open: boolean) => {
    setMoreOpen(open);
    if (open) setPenOpen(false);
  }, []);

  // PDF search owns Ctrl/Cmd+F while the reader is open. Editor.tsx also
  // checks for an open PDF reader before opening the note search.
  useEffect(() => {
    if (blocked || confirming) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        openSearch();
        return;
      }
      if (event.key === "Escape" && searchOpen) {
        closeSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blocked, confirming, searchOpen, openSearch, closeSearch]);

  // Ctrl/Cmd+A on the document selects PDF text only, never the app chrome.
  useEffect(() => {
    if (!pdf || blocked || confirming) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "a"
      )
        return;
      const active = document.activeElement as HTMLElement | null;
      const editingInReader =
        !!active?.closest(".pdf-reader") &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable);
      if (editingInReader) return;
      // The reader owns the visible document: Ctrl/Cmd+A must never fall
      // through to the app chrome behind it.
      event.preventDefault();
      selectAllPdfText();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const change = (next: PdfAnnotation[]) => {
    changeVersion.current += 1;
    currentEntries.current = next;
    setEntries(next);
    setDirty(true);
    setSavePhase((phase) => (phase === "saving" ? phase : "idle"));
    if (asset?.documentId && file)
      try {
        localStorage.setItem(
          draftKey(asset.documentId),
          JSON.stringify({ ...file, entries: next }),
        );
      } catch {
        setError(
          "Draft recovery storage is full. Keep this PDF open until annotations are saved.",
        );
      }
  };
  const save = async () => {
    if (!asset || !file || savingRef.current) return;
    const versionAtStart = changeVersion.current;
    const snapshot = currentEntries.current;
    savingRef.current = true;
    setSavePhase("saving");
    setError("");
    let next: AnnotationFile;
    try {
      next = await research.save(asset, file.revision, snapshot);
    } catch (e) {
      setSavePhase("failed");
      setError(String(e));
      savingRef.current = false;
      return;
    }
    setFile(next);
    const latest = currentEntries.current;
    if (changeVersion.current === versionAtStart) {
      setDirty(false);
      try {
        localStorage.removeItem(draftKey(asset.documentId!));
      } catch {
        // The save itself succeeded; a storage cleanup failure must not
        // turn a successful save into a false "Save failed" state.
      }
    } else {
      try {
        localStorage.setItem(
          draftKey(asset.documentId!),
          JSON.stringify({ ...next, entries: latest }),
        );
      } catch {
        setError(
          "Draft recovery storage is full. Keep this PDF open until annotations are saved.",
        );
      }
    }
    setSavePhase("idle");
    savingRef.current = false;
  };
  const add = (parts: SelectionPart[]) => {
    const now = Date.now();
    const added = parts.map((part) => ({
      ...part,
      id: crypto.randomUUID(),
      color,
      comment: "",
      createdAt: now,
      updatedAt: now,
    }));
    change([...entries, ...added]);
    setSelected(added[0]?.id ?? "");
    setSelection([]);
    window.getSelection()?.removeAllRanges();
    setPointMode(false);
  };
  const readSelectionParts = (): SelectionPart[] => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !pages.current) return [];
    const range = sel.getRangeAt(0);
    const parts: SelectionPart[] = [];
    for (const el of pages.current.querySelectorAll<HTMLElement>(
      "[data-pdf-page]",
    )) {
      const layer = el.querySelector(".textLayer");
      if (!layer || !range.intersectsNode(layer)) continue;
      const n = Number(el.dataset.pdfPage),
        vp = viewports.current.get(n);
      if (!vp) continue;
      const clipped = range.cloneRange();
      const content = document.createRange();
      content.selectNodeContents(layer);
      if (range.compareBoundaryPoints(Range.START_TO_START, content) < 0)
        clipped.setStart(content.startContainer, content.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, content) > 0)
        clipped.setEnd(content.endContainer, content.endOffset);
      const box = el.getBoundingClientRect();
      const rects = Array.from(clipped.getClientRects())
        .filter(
          (r) =>
            r.width > 0 &&
            r.height > 0 &&
            r.left >= box.left - 1 &&
            r.right <= box.right + 1,
        )
        .map((r) => {
          const p1 = vp.convertToPdfPoint(r.left - box.left, r.top - box.top),
            p2 = vp.convertToPdfPoint(r.right - box.left, r.bottom - box.top);
          return [...p1, ...p2] as [number, number, number, number];
        });
      if (rects.length)
        parts.push({
          page: n,
          rects,
          text: clipped.toString().slice(0, 100000),
        });
    }
    return parts;
  };
  const capture = () => setSelection(readSelectionParts());
  const readPdfSelectionText = (): string => {
    const sel = window.getSelection();
    const container = pages.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !container) return "";
    let text = "";
    try {
      const bounds = document.createRange();
      bounds.selectNodeContents(container);
      for (let i = 0; i < sel.rangeCount; i++) {
        const source = sel.getRangeAt(i);
        if (source.collapsed || !source.intersectsNode(container)) continue;
        const clipped = source.cloneRange();
        if (
          source.compareBoundaryPoints(Range.START_TO_START, bounds) < 0
        ) {
          clipped.setStart(bounds.startContainer, bounds.startOffset);
        }
        if (source.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
          clipped.setEnd(bounds.endContainer, bounds.endOffset);
        }
        text += clipped.toString();
      }
    } catch {
      return "";
    }
    return text;
  };
  const selectAllPdfText = () => {
    const container = pages.current;
    if (!container) return;
    const layers = Array.from(
      container.querySelectorAll<HTMLElement>(".textLayer"),
    ).filter((layer) => layer.firstChild);
    if (!layers.length) return;
    const first = layers[0];
    const last = layers[layers.length - 1];
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    setSelection(readSelectionParts());
    container.focus({ preventScroll: true });
  };
  const search = async () => {
    if (!pdf || !query.trim()) return;
    const run = ++searchRun.current;
    setSearching(true);
    setSearchDone(false);
    const found: number[] = [];
    try {
      for (let n = 1; n <= pdf.numPages; n++) {
        const p = await pdf.getPage(n);
        const t = await p.getTextContent();
        if (run !== searchRun.current) return;
        if (
          t.items
            .map((i) => ("str" in i ? i.str : ""))
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase())
        )
          found.push(n);
      }
      setMatches(found);
      setSearchDone(true);
      if (found.length) navigate(found[0]);
    } catch (e) {
      setError(String(e));
    } finally {
      if (run === searchRun.current) setSearching(false);
    }
  };
  const quote = (a: PdfAnnotation) => {
    if (!notePath || !asset?.documentId) return;
    const text = `\n> ${(a.text || a.comment).replace(/\n/g, "\n> ")}\n\n[PDF · page ${a.page}](prism-pdf:${asset.documentId}?page=${a.page}&annotation=${a.id})\n`;
    window.dispatchEvent(
      new CustomEvent("prism-insert-quote", {
        detail: { path: notePath, text },
      }),
    );
  };
  const hitAnnotation = (
    target: Element,
    clientX: number,
    clientY: number,
  ): string | undefined => {
    const pageEl = target.closest<HTMLElement>("[data-pdf-page]");
    if (!pageEl) return undefined;
    const n = Number(pageEl.dataset.pdfPage);
    const vp = viewports.current.get(n);
    if (!vp) return undefined;
    const box = pageEl.getBoundingClientRect();
    const [x, y] = vp.convertToPdfPoint(
      clientX - box.left,
      clientY - box.top,
    );
    return entries.find(
      (a) =>
        a.page === n &&
        a.rects.some(
          (r) =>
            x >= Math.min(r[0], r[2]) &&
            x <= Math.max(r[0], r[2]) &&
            y >= Math.min(r[1], r[3]) &&
            y <= Math.max(r[1], r[3]),
        ),
    )?.id;
  };
  const openContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as Element;
    if (target.closest(".pdf-menu-surface")) return;
    const container = pages.current;
    const inPages = !!target.closest(".pdf-pages");
    const article = target.closest<HTMLElement>("[data-annotation-id]");
    const inAnnotations = !!target.closest(".pdf-annotations");
    const editable = target.closest<HTMLInputElement | HTMLTextAreaElement>(
      "textarea, input, [contenteditable='true']",
    );
    const activeField =
      editable &&
      !editable.hasAttribute("disabled") &&
      !editable.hasAttribute("readonly")
        ? editable
        : null;
    if (!inPages && !inAnnotations && !activeField) {
      setContextMenu(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setPenOpen(false);
    setMoreOpen(false);
    contextEditable.current = activeField;
    contextFieldRange.current = null;
    let fieldSelection = "";
    if (
      editable &&
      (editable instanceof HTMLTextAreaElement ||
        editable instanceof HTMLInputElement) &&
      editable.selectionStart !== null &&
      editable.selectionEnd !== null
    ) {
      contextFieldRange.current = {
        start: editable.selectionStart,
        end: editable.selectionEnd,
      };
      if (editable.selectionEnd > editable.selectionStart) {
        fieldSelection = editable.value.slice(
          editable.selectionStart,
          editable.selectionEnd,
        );
      }
    }
    const pdfSelection = inPages ? readPdfSelectionText() : "";
    const area = inPages
      ? "page"
      : inAnnotations
        ? "annotation"
        : "field";
    // Keyboard context-menu events carry 0,0; anchor the menu to the focused
    // element instead of the top-left corner.
    const pointer = event.clientX !== 0 || event.clientY !== 0;
    const box = target.getBoundingClientRect();
    const x = pointer ? event.clientX : box.left + 8;
    const y = pointer ? event.clientY : box.top + 8;
    const annotationId =
      article?.dataset.annotationId ??
      (inPages ? hitAnnotation(target, x, y) : undefined);
    if (!container && inPages) {
      setContextMenu(null);
      return;
    }
    setContextMenu({
      x,
      y,
      annotationId,
      area,
      editable: !!contextEditable.current,
      hasSelection: !!(fieldSelection || pdfSelection),
      selectionText: fieldSelection || pdfSelection,
    });
  };
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const copyContextSelection = async () => {
    const text = contextMenu?.selectionText ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy copy path for WebViews without clipboard
      // write permission.
    }
    if (!legacyCopy(text)) {
      setError(
        "Clipboard access is unavailable. Select the text and use Ctrl/Cmd+C.",
      );
    }
  };
  const pasteContextSelection = async () => {
    const el = contextEditable.current;
    if (!el || !el.isConnected) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setError(
        "Clipboard access is unavailable. Use Ctrl/Cmd+V to paste instead.",
      );
      return;
    }
    if (!text) return;
    el.focus();
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement
    ) {
      const start =
        contextFieldRange.current?.start ?? el.selectionStart ?? el.value.length;
      const end =
        contextFieldRange.current?.end ?? el.selectionEnd ?? start;
      const next = el.value.slice(0, start) + text + el.value.slice(end);
      const prototype =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(el, next);
      el.setSelectionRange(start + text.length, start + text.length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    try {
      if (!document.execCommand("insertText", false, text)) {
        setError("Could not paste into this annotation field.");
      }
    } catch {
      setError("Could not paste into this annotation field.");
    }
  };
  const selectAllContext = () => {
    const el = contextEditable.current;
    if (el) {
      el.focus();
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement
      ) {
        el.select();
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    selectAllPdfText();
  };
  const editContextAnnotation = () => {
    const a = contextMenu?.annotationId
      ? entries.find((item) => item.id === contextMenu.annotationId)
      : undefined;
    if (!a) return;
    setAnnotationsOpen(true);
    setSelected(a.id);
    navigate(a.page);
    requestAnimationFrame(() => {
      document
        .getElementById(`pdf-annotation-${a.id}`)
        ?.focus({ preventScroll: true });
    });
  };
  const quoteContextAnnotation = () => {
    const a = contextMenu?.annotationId
      ? entries.find((item) => item.id === contextMenu.annotationId)
      : undefined;
    if (a) quote(a);
  };
  const deleteContextAnnotation = () => {
    const id = contextMenu?.annotationId;
    if (!id) return;
    change(entries.filter((item) => item.id !== id));
    if (selected === id) setSelected("");
  };
  const contextAnnotation = contextMenu?.annotationId
    ? entries.find((item) => item.id === contextMenu.annotationId)
    : undefined;
  const saveState = !file
    ? "opening"
    : savePhase === "saving"
      ? "saving"
      : savePhase === "failed"
        ? "failed"
        : dirty
          ? "unsaved"
          : "saved";
  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "failed"
        ? "Save failed"
        : saveState === "unsaved"
          ? "Unsaved"
          : saveState === "saved"
            ? "Saved"
            : "Opening…";
  const saveTitle =
    saveState === "saving"
      ? "Saving annotations…"
      : saveState === "failed"
        ? "Retry saving annotations"
        : saveState === "unsaved"
          ? "Save annotations"
          : saveState === "saved"
            ? "Annotations saved"
            : "Opening PDF…";
  return (
    <section
      inert={blocked || confirming}
      className="pdf-reader"
      data-region="pdf"
      aria-label="PDF reader"
      onContextMenu={openContextMenu}
    >
      <header className="pdf-toolbar pdf-header">
        <strong className="pdf-title">PDF reader</strong>
        {pdf && (
          <>
            <div
              className="pdf-toolbar-group"
              role="group"
              aria-label="Page navigation"
            >
              <button
                type="button"
                className="pdf-icon-button"
                aria-label="Previous page"
                title="Previous page"
                disabled={page <= 1}
                onClick={() => navigate(page - 1)}
              >
                <ChevronLeft size={18} aria-hidden="true" />
              </button>
              <label className="pdf-page-field">
                Page{" "}
                <input
                  type="number"
                  min={1}
                  max={pdf.numPages}
                  value={page}
                  onChange={(e) => navigate(Number(e.target.value))}
                />
              </label>
              <span className="pdf-page-total">of {pdf.numPages}</span>
              <button
                type="button"
                className="pdf-icon-button"
                aria-label="Next page"
                title="Next page"
                disabled={page >= pdf.numPages}
                onClick={() => navigate(page + 1)}
              >
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            </div>
            <div
              className="pdf-toolbar-group"
              role="group"
              aria-label="Zoom"
            >
              <button
                type="button"
                className="pdf-icon-button"
                aria-label="Zoom out"
                title="Zoom out"
                onClick={() => setScale((v) => Math.max(0.4, v - 0.2))}
              >
                <ZoomOut size={18} aria-hidden="true" />
              </button>
              <span className="pdf-zoom-value">
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                className="pdf-icon-button"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={() => setScale((v) => Math.min(3, v + 0.2))}
              >
                <ZoomIn size={18} aria-hidden="true" />
              </button>
            </div>
          </>
        )}
        <div className="pdf-toolbar-actions">
          {pdf && (
            <>
              <button
                ref={findTrigger}
                type="button"
                className="pdf-icon-button"
                aria-label="Find in PDF"
                title="Find in PDF (Ctrl/Cmd+F)"
                aria-expanded={searchOpen}
                aria-controls={searchOpen ? "pdf-find" : undefined}
                onClick={openSearch}
              >
                <Search size={18} aria-hidden="true" />
              </button>
              <PdfToolbarMenu
                id="pdf-annotation-tools"
                label="Annotation tools"
                icon={<PenLine size={18} aria-hidden="true" />}
                triggerRef={penTrigger}
                open={penOpen}
                setOpen={setPenMenu}
              >
                <button
                  type="button"
                  className="pdf-menu-item"
                  disabled={!selection.length}
                  onClick={() => {
                    add(selection);
                    setPenOpen(false);
                  }}
                >
                  <Highlighter aria-hidden="true" />
                  Highlight selection
                </button>
                <button
                  type="button"
                  className="pdf-menu-item"
                  aria-pressed={pointMode}
                  onClick={() => {
                    setPointMode((value) => !value);
                    setPenOpen(false);
                  }}
                >
                  <MessageSquarePlus aria-hidden="true" />
                  Add point comment
                </button>
                <div className="pdf-menu-sep" />
                <div className="pdf-menu-label">Highlight color</div>
                <ColorSwatches
                  color={color}
                  change={setColor}
                  label="Highlight color"
                />
                <p className="pdf-menu-hint">
                  {pointMode
                    ? "Click a page to place a comment."
                    : "Select PDF text to highlight it."}
                </p>
              </PdfToolbarMenu>
              <div className="pdf-save-group">
                <button
                  type="button"
                  className="pdf-icon-button pdf-save-button"
                  data-state={saveState}
                  aria-label="Save annotations"
                  title={saveTitle}
                  aria-busy={savePhase === "saving"}
                  disabled={!file || !dirty || savePhase === "saving"}
                  onClick={() => void save()}
                >
                  {savePhase === "saving" ? (
                    <Loader2
                      size={18}
                      className="pdf-save-spinner"
                      aria-hidden="true"
                    />
                  ) : (
                    <Save size={18} aria-hidden="true" />
                  )}
                </button>
                <span className="pdf-save-status" role="status">
                  {saveLabel}
                </span>
              </div>
              <PdfToolbarMenu
                id="pdf-more-options"
                label="More options"
                icon={<EllipsisVertical size={18} aria-hidden="true" />}
                triggerRef={moreTrigger}
                open={moreOpen}
                setOpen={setMoreMenu}
              >
                <button
                  type="button"
                  className="pdf-menu-item"
                  onClick={() => {
                    setRotation((value) => (value + 90) % 360);
                    setMoreOpen(false);
                    requestAnimationFrame(() => moreTrigger.current?.focus());
                  }}
                >
                  <RotateCw aria-hidden="true" />
                  Rotate
                </button>
                <button
                  type="button"
                  className="pdf-menu-item"
                  aria-pressed={annotationsOpen}
                  aria-controls="pdf-annotations"
                  title="Show or hide the annotations panel"
                  onClick={() => {
                    setAnnotationsOpen((value) => !value);
                    setMoreOpen(false);
                    requestAnimationFrame(() => moreTrigger.current?.focus());
                  }}
                >
                  {annotationsOpen ? (
                    <PanelRightClose aria-hidden="true" />
                  ) : (
                    <PanelRightOpen aria-hidden="true" />
                  )}
                  Annotations ({entries.length})
                </button>
              </PdfToolbarMenu>
            </>
          )}
          <button
            type="button"
            className="pdf-icon-button pdf-close"
            aria-label="Close PDF"
            title="Close PDF"
            onClick={close}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      {searchOpen && (
        <div id="pdf-find" className="pdf-find" role="search" aria-label="Find in PDF">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInput}
            aria-label="Find in PDF"
            placeholder="Find in PDF…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              searchRun.current++;
              setSearching(false);
              setSearchDone(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void search();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <button
            type="button"
            className="pdf-icon-button"
            aria-label="Search PDF"
            title={searching ? "Searching…" : "Search PDF"}
            aria-busy={searching}
            disabled={searching || !query.trim()}
            onClick={() => void search()}
          >
            {searching ? (
              <Loader2 size={16} className="pdf-save-spinner" aria-hidden="true" />
            ) : (
              <Search size={16} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="pdf-icon-button"
            aria-label="Close search"
            title="Close search (Esc)"
            onClick={closeSearch}
          >
            <X size={16} aria-hidden="true" />
          </button>
          {searchDone && (
            <span className="pdf-find-status" aria-live="polite">
              {matches.length
                ? `${matches.length} matching page${matches.length === 1 ? "" : "s"}`
                : "No matching pages"}
            </span>
          )}
          {searchDone &&
            matches.map((n) => (
              <button
                key={n}
                type="button"
                className="pdf-find-page"
                onClick={() => navigate(n)}
              >
                Page {n}
              </button>
            ))}
        </div>
      )}
      {pointMode && (
        <p className="pdf-mode-hint" aria-live="polite">
          Click a page to place a comment.
        </p>
      )}
      {error && (
        <div role="alert">
          {error}
          {(dirty || invalidDraft !== null) && (
            <button
              onClick={async () => {
                setConfirming(true);
                try {
                  if (
                    asset?.documentId &&
                    (await confirm(
                      "Discard this draft and reload the saved annotations?",
                      { title: "Discard draft" },
                    ))
                  ) {
                    localStorage.removeItem(draftKey(asset.documentId));
                    setDirty(false);
                    setSavePhase("idle");
                    setAttempt((v) => v + 1);
                  }
                } finally {
                  setConfirming(false);
                }
              }}
            >
              Reload saved annotations
            </button>
          )}
          {request.documentId && (
            <button
              onClick={() => {
                setRelink(true);
                setAttempt((v) => v + 1);
              }}
            >
              Relink identical PDF
            </button>
          )}
          {(dirty || invalidDraft !== null) && (
            <button
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      invalidDraft ??
                        JSON.stringify({ ...file, entries }, null, 2),
                    ],
                    {
                      type: "application/json",
                    },
                  ),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "annotations-draft.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download unsaved draft
            </button>
          )}
        </div>
      )}
      {needsPassword && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            passwordCallback.current?.(password);
            setNeedsPassword(false);
            setPassword("");
          }}
        >
          <label>
            PDF password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button>Unlock</button>
        </form>
      )}
      {pdf && (
        <>
          <div className="pdf-layout">
            <div
              ref={pages}
              className="pdf-pages"
              tabIndex={-1}
              onMouseUp={capture}
              onKeyUp={capture}
            >
              {Array.from({ length: pdf.numPages }, (_, i) => (
                <PdfPage
                  key={i + 1}
                  pdf={pdf}
                  page={i + 1}
                  scale={scale}
                  rotation={rotation}
                  annotations={entries.filter((a) => a.page === i + 1)}
                  selected={selected}
                  register={(vp) => viewports.current.set(i + 1, vp)}
                  fail={setError}
                  point={
                    pointMode
                      ? (rect) =>
                          add([{ page: i + 1, rects: [rect], text: "" }])
                      : undefined
                  }
                />
              ))}
            </div>
            <aside id="pdf-annotations" hidden={!annotationsOpen} className="pdf-annotations" aria-label="Annotations">
              {entries.length === 0 && <p>No annotations yet.</p>}
              {entries.map((a) => (
                <article key={a.id} data-annotation-id={a.id} data-selected={selected === a.id}>
                  <button className="pdf-annotation-heading"
                    onClick={() => {
                      setSelected(a.id);
                      navigate(a.page);
                    }}
                  >
                    Page {a.page} · {a.text || "Point comment"}
                  </button>
                  <label>
                    Comment
                    <textarea
                      id={`pdf-annotation-${a.id}`}
                      aria-label={`Comment on page ${a.page}`}
                      value={a.comment}
                      onFocus={() => setSelected(a.id)}
                      onChange={(e) =>
                        change(
                          entries.map((item) =>
                            item.id === a.id
                              ? {
                                  ...item,
                                  comment: e.target.value,
                                  updatedAt: Date.now(),
                                }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <ColorPicker color={a.color} label={`Annotation color on page ${a.page}`} change={color => change(entries.map(item => item.id === a.id ? { ...item, color, updatedAt: Date.now() } : item))} />
                  <button
                    disabled={!notePath}
                    title={!notePath ? "Select a note first" : undefined}
                    onClick={() => quote(a)}
                  >
                    Insert quote into note
                  </button>
                  <button
                    onClick={() =>
                      change(entries.filter((item) => item.id !== a.id))
                    }
                  >
                    Delete annotation
                  </button>
                </article>
              ))}
            </aside>
          </div>
        </>
      )}
      {contextMenu && (
        <PdfContextMenu
          menu={contextMenu}
          hasAnnotation={!!contextAnnotation}
          canQuote={!!notePath && !!contextAnnotation}
          onClose={closeContextMenu}
          onCopy={() => void copyContextSelection()}
          onPaste={() => void pasteContextSelection()}
          onSelectAll={selectAllContext}
          onHighlight={() => {
            const parts = readSelectionParts();
            if (parts.length) add(parts);
          }}
          onAddPoint={() => {
            setPointMode(true);
            setContextMenu(null);
          }}
          onEditComment={editContextAnnotation}
          onQuote={quoteContextAnnotation}
          onDelete={deleteContextAnnotation}
        />
      )}
    </section>
  );
}
function PdfPage({
  pdf,
  page,
  scale,
  rotation,
  annotations,
  selected,
  register,
  fail,
  point,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  scale: number;
  rotation: number;
  annotations: PdfAnnotation[];
  selected: string;
  register: (vp: ReturnType<PDFPageProxy["getViewport"]>) => void;
  fail: (error: string) => void;
  point?: (rect: [number, number, number, number]) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false),
    [vp, setVp] = useState<ReturnType<PDFPageProxy["getViewport"]> | null>(
      null,
    );
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      { root: root.current?.parentElement, rootMargin: "1000px" },
    );
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!near) return;
    let alive = true,
      render: ReturnType<PDFPageProxy["render"]> | undefined,
      layer: TextLayer | undefined;
    void (async () => {
      const p = await pdf.getPage(page);
      if (!alive) return;
      const viewport = p.getViewport({
        scale,
        rotation: (p.rotate + rotation) % 360,
      });
      setVp(viewport);
      register(viewport);
      const c = canvas.current!,
        t = text.current!;
      t.replaceChildren();
      t.style.setProperty("--scale-factor", String(scale));
      t.style.setProperty("--total-scale-factor", String(scale));
      const dpr = Math.min(devicePixelRatio, 2);
      c.width = Math.floor(viewport.width * dpr);
      c.height = Math.floor(viewport.height * dpr);
      c.style.width = `${viewport.width}px`;
      c.style.height = `${viewport.height}px`;
      render = p.render({
        canvas: c,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });
      layer = new TextLayer({
        container: t,
        viewport,
        textContentSource: p.streamTextContent(),
      });
      await Promise.all([render.promise, layer.render()]);
    })().catch((e) => {
      if (alive && e?.name !== "RenderingCancelledException") fail(String(e));
    });
    return () => {
      alive = false;
      render?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, scale, rotation, near]);
  return (
    <div
      ref={root}
      className="pdf-page"
      data-pdf-page={page}
      style={{
        width: vp?.width ?? 612 * scale,
        height: vp?.height ?? 792 * scale,
      }}
      onClick={(e) => {
        if (!point || !vp) return;
        const r = e.currentTarget.getBoundingClientRect(),
          p = vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
        point([p[0], p[1], p[0] + 12, p[1] + 12]);
      }}
    >
      {near && (
        <>
          <canvas ref={canvas} />
          <div ref={text} className="textLayer" />
          {vp &&
            annotations.flatMap((a) =>
              a.rects.map((r, i) => {
                const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]);
                const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
                return (
                  <span
                    key={`${a.id}-${i}`}
                    className={a.text ? "pdf-mark" : "pdf-comment-dot"}
                    data-selected={selected === a.id}
                    style={{
                      left: Math.min(x1, x2),
                      top: Math.min(y1, y2),
                      width: Math.max(12, Math.abs(x2 - x1)),
                      height: Math.max(12, Math.abs(y2 - y1)),
                      backgroundColor: colors[a.color] ?? colors.yellow,
                    }}
                  />
                );
              }),
            )}
        </>
      )}
    </div>
  );
}
