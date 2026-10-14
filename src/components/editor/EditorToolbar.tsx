import type { ReactNode } from "react";
export type EditorMode = "live" | "edit" | "preview";
export function EditorToolbar({
  mode,
  change,
  format,
  find,
  attach,
  saved,
  title,
  children,
}: {
  mode: EditorMode;
  change: (mode: EditorMode) => void;
  format: (kind: string) => void;
  find: () => void;
  attach: () => void;
  saved: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <header className="editor-toolbar">
      <div className="editor-title">
        <h2>{title}</h2>
        <span role="status">{saved ? "Saved" : "Unsaved changes"}</span>
      </div>
      <div className="editor-actions">
        <div className="seg-control editor-mode-group" role="group" aria-label="Editor mode">
          {(["live", "edit", "preview"] as const).map((value) => (
            <button
              key={value}
              className="seg-button"
              aria-pressed={mode === value}
              title={
                value === "edit"
                  ? "Edit mode: Switch to the raw markdown editor."
                  : value === "preview"
                    ? "Preview mode: Render this note as formatted markdown — headings, lists, links and tags. Saves before switching."
                    : "Live Markdown"
              }
              onClick={() => change(value)}
            >
              {value === "edit"
                ? "Source"
                : value === "preview"
                  ? "Read"
                  : "Live"}
            </button>
          ))}
        </div>
        <div className="editor-secondary-group">
          <details className="editor-format">
            <summary>Format</summary>
            <div>
              {["Bold", "Italic", "Heading", "Link", "Task", "Code"].map(
                (kind) => (
                  <button key={kind} onClick={() => format(kind)}>
                    {kind}
                  </button>
                ),
              )}
              <button onClick={attach}>Insert attachment</button>
            </div>
          </details>
          <button onClick={find}>Find</button>
          <details className="editor-overflow">
            <summary>More tools</summary>
            <div className="editor-overflow-body">{children}</div>
          </details>
        </div>
      </div>
    </header>
  );
}
