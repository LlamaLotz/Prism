import { useCallback, useEffect, useRef, useState } from "react";
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
GlobalWorkerOptions.workerSrc = workerUrl;
const colors: Record<string, string> = {
  yellow: "#f5d442",
  green: "#4bc882",
  blue: "#65a8f5",
  pink: "#f68bcc",
};
type SelectionPart = {
  page: number;
  rects: [number, number, number, number][];
  text: string;
};

export function PdfWorkspace({
  vaultPath,
  notePath,
}: {
  vaultPath: string;
  notePath?: string;
}) {
  const [request, setRequest] = useState<(PdfRequest & { key: number }) | null>(
    null,
  );
  const dirty = useRef(false);
  const discardDraft = useRef<() => void>(() => {});
  const [confirming, setConfirming] = useState(false);
  const dirtyChanged = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const registerDiscard = useCallback((fn: () => void) => {
    discardDraft.current = fn;
  }, []);
  const { confirm } = useDialog();
  const allowDiscard = async () => {
    if (!dirty.current) return true;
    const discard = discardDraft.current;
    setConfirming(true);
    try {
      if (
        !(await confirm("Discard unsaved PDF annotations?", {
          title: "Unsaved annotations",
        }))
      )
        return false;
      discard();
      dirty.current = false;
      return true;
    } finally {
      setConfirming(false);
    }
  };
  useEffect(() => {
    const open = async (e: Event) => {
      if (!(await allowDiscard())) return;
      setRequest({ ...(e as CustomEvent).detail, key: Date.now() });
    };
    window.addEventListener("prism-open-pdf", open);
    return () => window.removeEventListener("prism-open-pdf", open);
  }, [confirm]);
  useEffect(() => {
    setRequest(null);
    dirty.current = false;
  }, [vaultPath]);
  if (!request) return null;
  return (
    <PdfReader
      blocked={confirming}
      registerDiscard={registerDiscard}
      vaultPath={vaultPath}
      key={request.key}
      request={request}
      notePath={notePath}
      dirtyChanged={dirtyChanged}
      close={async () => {
        if (await allowDiscard()) setRequest(null);
      }}
    />
  );
}
function PdfReader({
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
  const [confirming, setConfirming] = useState(false);
  const [invalidDraft, setInvalidDraft] = useState<string | null>(null);
  const draftKey = (id: string) =>
    `prism_pdf_draft:${encodeURIComponent(vaultPath)}:${id}`;
  const [asset, setAsset] = useState<ResearchAsset | null>(null),
    [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState("");
  const [file, setFile] = useState<AnnotationFile | null>(null),
    [entries, setEntries] = useState<PdfAnnotation[]>([]),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
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
    [searchDone, setSearchDone] = useState(false);
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
  const currentEntries = useRef(entries);
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
  const change = (next: PdfAnnotation[]) => {
    currentEntries.current = next;
    setEntries(next);
    setDirty(true);
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
    if (!asset || !file) return;
    setBusy(true);
    setError("");
    const snapshot = entries;
    try {
      const next = await research.save(asset, file.revision, snapshot);
      setFile(next);
      if (currentEntries.current === snapshot) {
        setDirty(false);
        localStorage.removeItem(draftKey(asset.documentId!));
      } else {
        localStorage.setItem(
          draftKey(asset.documentId!),
          JSON.stringify({ ...next, entries: currentEntries.current }),
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
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
  const capture = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !pages.current) return;
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
    setSelection(parts);
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
  return (
    <section
      inert={blocked || confirming}
      className="pdf-reader"
      aria-label="PDF reader"
    >
      <header className="pdf-toolbar">
        <strong>PDF reader</strong>
        <button onClick={close}>Close PDF</button>
        <button disabled={!dirty || busy || !file} onClick={() => void save()}>
          {busy ? "Saving…" : "Save annotations"}
        </button>
        <span role="status">
          {dirty
            ? "Unsaved annotations"
            : file
              ? "Annotations saved"
              : "Opening PDF…"}
        </span>
      </header>
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
          <nav className="pdf-toolbar" aria-label="PDF navigation">
            <button disabled={page <= 1} onClick={() => navigate(page - 1)}>
              Previous page
            </button>
            <label>
              Page{" "}
              <input
                type="number"
                min={1}
                max={pdf.numPages}
                value={page}
                onChange={(e) => navigate(Number(e.target.value))}
              />
            </label>
            <span>of {pdf.numPages}</span>
            <button
              disabled={page >= pdf.numPages}
              onClick={() => navigate(page + 1)}
            >
              Next page
            </button>
            <button onClick={() => setScale((v) => Math.max(0.4, v - 0.2))}>
              Zoom out
            </button>
            <span>{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale((v) => Math.min(3, v + 0.2))}>
              Zoom in
            </button>
            <button onClick={() => setRotation((v) => (v + 90) % 360)}>
              Rotate
            </button>
            <input
              className="pdf-search"
              aria-label="Find in PDF"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                searchRun.current++;
                setSearching(false);
                setSearchDone(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search();
              }}
            />
            <button disabled={searching} onClick={() => void search()}>
              {searching ? "Searching…" : "Search PDF"}
            </button>
            {searchDone && !matches.length && <span>No matching pages</span>}
            {searchDone &&
              matches.map((n) => (
                <button key={n} onClick={() => navigate(n)}>
                  Page {n}
                </button>
              ))}
          </nav>
          <div className="pdf-selection">
            <label>
              Highlight color{" "}
              <select value={color} onChange={(e) => setColor(e.target.value)}>
                {Object.keys(colors).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <button disabled={!selection.length} onClick={() => add(selection)}>
              Highlight selection
            </button>
            <button
              aria-pressed={pointMode}
              onClick={() => setPointMode((v) => !v)}
            >
              Add point comment
            </button>
            <span>
              {pointMode
                ? "Click a page to place a comment."
                : "Select PDF text to highlight it."}
            </span>
          </div>
          <div className="pdf-layout">
            <div
              ref={pages}
              className="pdf-pages"
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
            <aside className="pdf-annotations" aria-label="Annotations">
              {entries.length === 0 && <p>No annotations yet.</p>}
              {entries.map((a) => (
                <article key={a.id} data-selected={selected === a.id}>
                  <button
                    onClick={() => {
                      setSelected(a.id);
                      navigate(a.page);
                    }}
                  >
                    Page {a.page} · {a.text.slice(0, 90) || "Point comment"}
                  </button>
                  <label>
                    Comment
                    <textarea
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
                  <label>
                    Color
                    <select
                      value={a.color}
                      onChange={(e) =>
                        change(
                          entries.map((item) =>
                            item.id === a.id
                              ? {
                                  ...item,
                                  color: e.target.value,
                                  updatedAt: Date.now(),
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      {Object.keys(colors).map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
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
                    style={{
                      left: Math.min(x1, x2),
                      top: Math.min(y1, y2),
                      width: Math.max(12, Math.abs(x2 - x1)),
                      height: Math.max(12, Math.abs(y2 - y1)),
                      background: colors[a.color],
                      outline: selected === a.id ? "2px solid #222" : undefined,
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
