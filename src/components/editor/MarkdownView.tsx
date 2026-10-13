import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Media } from "./Media";
import {
  NoteLink,
  resolveNote,
  useExcerpt,
  type LinkContext,
} from "./NoteLink";
import { parseWikiLinkTarget } from "../../utils/markdownParser";
import { openPdf, parsePdfLink } from "../../services/research";

// Transform text AST nodes only: fenced code and inline code remain literal.
function prismLinks() {
  return (tree: any) => {
    const walk = (parent: any) => {
      if (["code", "inlineCode", "link", "image"].includes(parent.type)) return;
      if (!parent.children) return;
      parent.children = parent.children.flatMap((node: any) => {
        if (node.type !== "text") {
          walk(node);
          return [node];
        }
        const result: any[] = [];
        let last = 0;
        const re = /(!?)\[\[([^\]\n]+)\]\]/g;
        let m;
        while ((m = re.exec(node.value))) {
          if (m.index > last)
            result.push({
              type: "text",
              value: node.value.slice(last, m.index),
            });
          result.push({
            type: "link",
            url: `prism-${m[1] ? "embed" : "note"}:${encodeURIComponent(m[2])}`,
            children: [{ type: "text", value: m[2] }],
          });
          last = re.lastIndex;
        }
        if (last < node.value.length)
          result.push({ type: "text", value: node.value.slice(last) });
        return result;
      });
    };
    walk(tree);
  };
}
function EmbeddedNote({ raw, context }: { raw: string; context: LinkContext }) {
  const { targetTitle, blockId } = parseWikiLinkTarget(raw);
  const note = resolveNote(context.notes, targetTitle, context.notePath);
  const { text, error } = useExcerpt(
    note,
    context.activePath ?? context.notePath,
    context.activeContent,
    blockId,
  );
  if (
    /\.(png|jpe?g|gif|webp|avif|mp3|wav|ogg|m4a|mp4|webm|pdf)$/i.test(
      targetTitle,
    )
  )
    return (
      <Media
        target={targetTitle + (blockId ? `#${blockId}` : "")}
        notePath={context.notePath}
      />
    );
  return (
    <span className="embedded-note">
      <NoteLink raw={raw} context={context} />
      {error ? (
        <span role="alert">{error}</span>
      ) : text ? (
        <MarkdownView
          content={text}
          context={{
            ...context,
            activePath: context.activePath ?? context.notePath,
            notePath: note?.path ?? context.notePath,
          }}
          nested
        />
      ) : (
        <span>{note ? "Loading excerpt…" : "Note missing or ambiguous"}</span>
      )}
    </span>
  );
}
export function MarkdownView({
  content,
  context,
  nested = false,
  search = "",
  highlightLine,
}: {
  content: string;
  context: LinkContext;
  nested?: boolean;
  search?: string;
  highlightLine?: number;
}) {
  let visible = content.split("<!-- LINKER_START -->")[0];
  // Keep line offsets identical to source for navigation.
  visible = visible.replace(
    /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/,
    (value) => value.replace(/[^\n]/g, ""),
  );
  const components: any = {
    a: ({ href = "", children }: any) => {
      if (href.startsWith("prism-note:"))
        return (
          <NoteLink raw={decodeURIComponent(href.slice(11))} context={context}>
            {children}
          </NoteLink>
        );
      if (href.startsWith("prism-embed:"))
        return nested ? (
          <NoteLink
            raw={decodeURIComponent(href.slice(12))}
            context={context}
          />
        ) : (
          <EmbeddedNote
            raw={decodeURIComponent(href.slice(12))}
            context={context}
          />
        );
      const pdf = parsePdfLink(href);
      if (pdf)
        return (
          <button className="note-link-trigger" onClick={() => openPdf(pdf)}>
            {children}
          </button>
        );
      if (/^https?:|^mailto:/i.test(href))
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      if (/\.(mp3|wav|ogg|m4a|mp4|webm|pdf)(?:[?#]|$)/i.test(href))
        return (
          <Media
            target={href}
            notePath={context.notePath}
            alt={String(children)}
          />
        );
      return (
        <NoteLink
          raw={decodeURIComponent(href).replace(/\.md(?=#|$)/i, "")}
          context={context}
        >
          {children}
        </NoteLink>
      );
    },
    img: ({ src = "", alt = "" }: any) => (
      <Media target={src} notePath={context.notePath} alt={alt} />
    ),
  };
  for (const tag of [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "pre",
    "blockquote",
    "table",
    "tr",
    "hr",
  ])
    components[tag] = ({ node, children, ...props }: any) => {
      const start = node?.position?.start?.line;
      const end = node?.position?.end?.line;
      const Tag = (tag === "p" ? "div" : tag) as any;
      return (
        <Tag
          {...props}
          data-line={start ? start - 1 : undefined}
          data-line-end={end ? end - 1 : undefined}
          className={
            highlightLine && start <= highlightLine && end >= highlightLine
              ? "block-highlight"
              : undefined
          }
        >
          {children}
        </Tag>
      );
    };
  // Highlight text AST nodes; preserve source coordinates and syntax nodes.
  const highlight = () => (tree: any) => {
    if (!search) return;
    const walk = (n: any) => {
      if (
        n.type === "text" &&
        n.value.toLowerCase().includes(search.toLowerCase())
      )
        n.data = { hName: "mark" };
      n.children?.forEach(walk);
    };
    walk(tree);
  };
  return (
    <span className="rich-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, prismLinks, highlight]}
        components={components}
        skipHtml
        urlTransform={(url) =>
          /^prism-(note|embed|pdf):/.test(url) ? url : defaultUrlTransform(url)
        }
      >
        {visible}
      </ReactMarkdown>
    </span>
  );
}
