import { StateField, StateEffect, type EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownView } from "./MarkdownView";
import type { LinkContext } from "./NoteLink";

const viewport = StateEffect.define<{ from: number; to: number }>();
class Task extends WidgetType {
  constructor(
    readonly from: number,
    readonly checked: boolean,
  ) {
    super();
  }
  eq(other: Task) {
    return this.from === other.from && this.checked === other.checked;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.checked = this.checked;
    el.setAttribute("aria-label", "Toggle task");
    el.onchange = () => {
      view.dispatch({
        changes: {
          from: this.from,
          to: this.from + 3,
          insert: el.checked ? "[x]" : "[ ]",
        },
        userEvent: "input",
      });
    };
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
const renderedRoots = new WeakMap<
  HTMLElement,
  { root: Root; observer: ResizeObserver }
>();
class Rendered extends WidgetType {
  constructor(
    readonly text: string,
    readonly context: LinkContext,
  ) {
    super();
  }
  eq(other: Rendered) {
    return (
      this.text === other.text &&
      this.context.activeContent === other.context.activeContent &&
      this.context.notePath === other.context.notePath &&
      this.context.notes === other.context.notes
    );
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "live-rendered";
    const root = createRoot(el);
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(el);
    renderedRoots.set(el, { root, observer });
    root.render(<MarkdownView content={this.text} context={this.context} />);
    return el;
  }
  updateDOM(el: HTMLElement) {
    renderedRoots
      .get(el)
      ?.root.render(
        <MarkdownView content={this.text} context={this.context} />,
      );
    return true;
  }
  destroy(el: HTMLElement) {
    const entry = renderedRoots.get(el);
    entry?.observer.disconnect();
    queueMicrotask(() => entry?.root.unmount());
    renderedRoots.delete(el);
  }
  ignoreEvent() {
    return true;
  }
}
export function liveMarkdown(context: () => LinkContext) {
  function build(state: EditorState, range: { from: number; to: number }) {
    const currentContext = {
      ...context(),
      activeContent: state.doc.toString(),
    };
    const out: any[] = [],
      occupied: [number, number][] = [];
    const active = (from: number, to: number) =>
      state.selection.ranges.some((r) => r.from <= to && r.to >= from);
    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        const { from, to, name } = node;
        if (occupied.some(([a, b]) => from >= a && to <= b)) return false;
        const line = state.doc.lineAt(from);
        if (/^ATXHeading/.test(name))
          out.push(
            Decoration.line({
              class: `live-heading live-h${name.slice(-1)}`,
            }).range(line.from),
          );
        if (
          name === "FencedCode" ||
          name === "CodeBlock" ||
          name === "Blockquote"
        ) {
          for (let pos = line.from; pos <= to;) {
            const l = state.doc.lineAt(pos);
            out.push(
              Decoration.line({
                class: name === "Blockquote" ? "live-quote" : "live-code",
              }).range(l.from),
            );
            if (l.to === state.doc.length) break;
            pos = l.to + 1;
          }
        }
        if (name === "StrongEmphasis")
          out.push(Decoration.mark({ class: "live-strong" }).range(from, to));
        if (name === "Emphasis")
          out.push(Decoration.mark({ class: "live-emphasis" }).range(from, to));
        if (name === "InlineCode")
          out.push(
            Decoration.mark({ class: "live-inline-code" }).range(from, to),
          );
        if (active(line.from, state.doc.lineAt(to).to)) return;
        if (name === "Image" || name === "Link") {
          out.push(
            Decoration.replace({
              widget: new Rendered(
                state.doc.sliceString(from, to),
                currentContext,
              ),
            }).range(from, to),
          );
          occupied.push([from, to]);
          return false;
        }
        if (name === "TaskMarker") {
          out.push(
            Decoration.replace({
              widget: new Task(
                from,
                state.doc.sliceString(from, to).toLowerCase() === "[x]",
              ),
            }).range(from, to),
          );
          return false;
        }
        if (
          ["HeaderMark", "EmphasisMark", "CodeMark", "QuoteMark"].includes(name)
        )
          out.push(Decoration.replace({}).range(from, to));
      },
    });
    // Wiki syntax is not part of CommonMark's grammar. Limit scanning to visible lines.
    for (
      let pos = state.doc.lineAt(Math.min(range.from, state.doc.length)).from;
      pos <= Math.min(range.to, state.doc.length);
    ) {
      const line = state.doc.lineAt(pos);
      if (!active(line.from, line.to)) {
        const re = /!?\[\[[^\]\n]+\]\]/g;
        let m;
        while ((m = re.exec(line.text))) {
          const from = line.from + m.index,
            to = from + m[0].length;
          const n = syntaxTree(state).resolveInner(from, 1);
          let code = false;
          for (let p: typeof n | null = n; p; p = p.parent)
            if (["FencedCode", "CodeBlock", "InlineCode"].includes(p.name))
              code = true;
          if (!code && !occupied.some(([a, b]) => from < b && to > a))
            out.push(
              Decoration.replace({
                widget: new Rendered(m[0], currentContext),
              }).range(from, to),
            );
        }
      }
      if (line.to === state.doc.length) break;
      pos = line.to + 1;
    }
    return Decoration.set(out, true);
  }
  const field = StateField.define<{
    decorations: DecorationSet;
    range: { from: number; to: number };
  }>({
    create(state) {
      const range = { from: 0, to: Math.min(state.doc.length, 6000) };
      return { range, decorations: build(state, range) };
    },
    update(value, tr) {
      let range = {
        from: tr.changes.mapPos(value.range.from),
        to: tr.changes.mapPos(value.range.to),
      };
      for (const e of tr.effects) if (e.is(viewport)) range = e.value;
      return tr.docChanged ||
        tr.selection ||
        tr.effects.some((e) => e.is(viewport)) ||
        syntaxTree(tr.startState) !== syntaxTree(tr.state)
        ? { range, decorations: build(tr.state, range) }
        : value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });
  return [
    field,
    ViewPlugin.fromClass(
      class {
        pending = false;
        destroyed = false;
        constructor(readonly view: EditorView) {
          this.schedule();
        }
        update(u: any) {
          if (u.viewportChanged) this.schedule();
        }
        schedule() {
          if (this.pending) return;
          this.pending = true;
          queueMicrotask(() => {
            this.pending = false;
            if (!this.destroyed)
              this.view.dispatch({ effects: viewport.of(this.view.viewport) });
          });
        }
        destroy() {
          this.destroyed = true;
        }
      },
    ),
  ];
}
