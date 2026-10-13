import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { NoteFile } from "../../types";
import { findBlockLine, parseWikiLinkTarget } from "../../utils/markdownParser";
export function resolveNote(
  notes: NoteFile[],
  target: string,
  fromPath: string,
) {
  const normalized = target
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .toLowerCase();
  const folder = fromPath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  if (!normalized) return notes.find((n) => n.path === fromPath);
  const exact = notes.find(
    (n) =>
      n.path.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase() ===
      normalized,
  );
  if (exact) return exact;
  const candidates = notes.filter(
    (n) =>
      n.title.toLowerCase() === normalized ||
      n.path
        .replace(/\\/g, "/")
        .replace(/\.md$/i, "")
        .toLowerCase()
        .endsWith("/" + normalized),
  );
  return (
    candidates.find(
      (n) =>
        n.path.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase() ===
        `${folder}/${normalized}`.toLowerCase(),
    ) ?? (candidates.length === 1 ? candidates[0] : undefined)
  );
}
export function useExcerpt(
  note: NoteFile | undefined,
  activePath: string,
  activeContent: string,
  block?: string,
  enabled = true,
) {
  const [text, setText] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setText("");
    setError("");
    if (!note || !enabled) return;
    const extract = (content: string) => {
      const clean = content.split("<!-- LINKER_START -->")[0];
      const line = block ? findBlockLine(clean, block) : null;
      if (block && line === null) {
        setError(
          "Referenced heading or block was not found in this excerpt. Open the note to find it.",
        );
        return;
      }
      const lines = clean.split("\n");
      const start = line ?? 0;
      let end = Math.min(lines.length, start + 30);
      if (block && !block.startsWith("^")) {
        const level = /^#+/.exec(lines[start])?.[0].length ?? 6;
        for (let i = start + 1; i < end; i++)
          if ((/^#+(?=\s)/.exec(lines[i])?.[0].length ?? 99) <= level) {
            end = i;
            break;
          }
      }
      setText(lines.slice(start, end).join("\n").slice(0, 4000));
    };
    if (note.path === activePath) extract(activeContent);
    else if (note.content !== undefined) extract(note.content);
    else
      void invoke<{ text: string }>("read_note_chunk", {
        path: note.path,
        offset: 0,
        expectedRevision: null,
      })
        .then((chunk) => {
          if (alive) extract(chunk.text);
        })
        .catch((e) => {
          if (alive) setError(String(e));
        });
    return () => {
      alive = false;
    };
  }, [note?.path, note?.content, activePath, activeContent, block, enabled]);
  return { text, error };
}
export interface LinkContext {
  notes: NoteFile[];
  notePath: string;
  activeContent: string;
  activePath?: string;
  onOpen: (title: string, block?: string) => void;
}
export function NoteLink({
  raw,
  children,
  context,
}: {
  raw: string;
  children?: React.ReactNode;
  context: LinkContext;
}) {
  const { targetTitle, blockId, alias } = parseWikiLinkTarget(raw);
  const note = resolveNote(context.notes, targetTitle, context.notePath);
  const [open, setOpen] = useState(false);
  const suppressFocus = useRef(false);
  const dismiss = () => {
    clearTimeout(timer.current);
    setOpen(false);
    suppressFocus.current = true;
    root.current?.querySelector("button")?.focus();
    suppressFocus.current = false;
  };
  const root = useRef<HTMLSpanElement>(null),
    popup = useRef<HTMLSpanElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const show = () => {
    clearTimeout(timer.current);
    const box = root.current?.getBoundingClientRect();
    if (box)
      setPosition({
        left: Math.max(8, Math.min(box.left, innerWidth - 360)),
        top: Math.min(box.bottom + 4, innerHeight - 280),
      });
    setOpen(true);
  };
  const hide = () => {
    timer.current = setTimeout(() => setOpen(false), 180);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const { text, error } = useExcerpt(
    note,
    context.activePath ?? context.notePath,
    context.activeContent,
    blockId,
    open,
  );
  return (
    <span
      ref={root}
      className="note-link"
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={() => {
        if (!suppressFocus.current) show();
      }}
      onBlur={(e) => {
        if (
          !root.current?.contains(e.relatedTarget) &&
          !popup.current?.contains(e.relatedTarget)
        )
          hide();
      }}
      onKeyDown={(e) => {
        if (
          e.key === "ArrowDown" ||
          (e.key === "Tab" &&
            !e.shiftKey &&
            e.target === root.current?.querySelector("button") &&
            open)
        ) {
          e.preventDefault();
          show();
          requestAnimationFrame(() =>
            popup.current?.querySelector("button")?.focus(),
          );
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          dismiss();
        }
      }}
    >
      <button
        className="note-link-trigger"
        onClick={() => context.onOpen(note?.path ?? targetTitle, blockId)}
      >
        {children || alias || targetTitle}
      </button>
      {open &&
        createPortal(
          <span
            ref={popup}
            className="note-link-popover"
            style={{ position: "fixed", ...position }}
            onMouseEnter={() => clearTimeout(timer.current)}
            onMouseLeave={hide}
            onFocus={() => clearTimeout(timer.current)}
            onBlur={(e) => {
              if (
                !popup.current?.contains(e.relatedTarget) &&
                !root.current?.contains(e.relatedTarget)
              )
                hide();
            }}
            role="group"
            aria-label={`Preview of ${targetTitle}`}
          >
            <strong>{note?.title ?? targetTitle}</strong>
            <span>
              {!note
                ? "Note missing or title ambiguous. Open to resolve."
                : error || text || "Loading preview…"}
            </span>
            <button
              onClick={() => {
                setOpen(false);
                context.onOpen(note?.path ?? targetTitle, blockId);
              }}
            >
              Open note
            </button>
          </span>,
          document.body,
        )}
    </span>
  );
}
