import { parseDocument, isMap, isScalar, isSeq } from "yaml";

export const propertyKeys = ["tags", "aliases", "status", "source"] as const;
export type PropertyKey = (typeof propertyKeys)[number];
export type NoteProperties = {
  tags: string[];
  aliases: string[];
  status: string;
  source: string;
};
export function readProperties(text: string) {
  const front = text.slice(0, 256 * 1024);
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(front);
  const empty: NoteProperties = {
    tags: [],
    aliases: [],
    status: "",
    source: "",
  };
  if (!match)
    return {
      values: empty,
      error: /^(?:\uFEFF)?---\r?\n/.test(text)
        ? "Unclosed frontmatter. Edit it in Source."
        : "",
      match: null,
      doc: null,
    };
  const doc = parseDocument(match[1], {
    keepSourceTokens: true,
    uniqueKeys: true,
  });
  let error =
    doc.errors.length || (doc.contents && !isMap(doc.contents))
      ? "Frontmatter must be a valid YAML mapping with unique keys."
      : "";
  const values = { ...empty };
  if (!error)
    for (const key of propertyKeys) {
      const node = doc.get(key, true);
      if (node == null) continue;
      if ((node as any).anchor || (node as any).tag) {
        error = `${key} uses YAML anchors or tags. Edit it in Source.`;
        continue;
      }
      if (key === "tags" || key === "aliases") {
        if (
          isSeq(node) &&
          node.items.every(
            (item) => isScalar(item) && typeof item.value === "string",
          )
        )
          values[key] = node.items.map((item) => String((item as any).value));
        else if (isScalar(node) && typeof node.value === "string")
          values[key] = [node.value];
        else error = `${key} must be text or a list of text values.`;
      } else if (
        isScalar(node) &&
        (node.value === null || typeof node.value === "string")
      )
        values[key] = String(node.value ?? "");
      else error = `${key} must be text.`;
    }
  return { values, error, match, doc };
}
/** Patch only the selected YAML value; unrelated bytes (including comments) survive. */
export function propertyChange(
  text: string,
  key: PropertyKey,
  value: string | string[],
) {
  const parsed = readProperties(text);
  if (parsed.error) throw new Error(parsed.error);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // JSON flow syntax is valid YAML and safely quotes punctuation, commas and colons.
  const serialized = JSON.stringify(value);
  if (!parsed.match)
    return {
      from: text.startsWith("\uFEFF") ? 1 : 0,
      to: text.startsWith("\uFEFF") ? 1 : 0,
      insert: `---${eol}${key}: ${serialized}${eol}---${eol}`,
    };
  const offset = parsed.match[0].indexOf("\n") + 1;
  const node = parsed.doc!.get(key, true) as
    { range?: [number, number, number] } | undefined;
  if (node?.range) {
    const [start, end] = node.range;
    // Block collections consume their trailing newline; preserve it when replacing.
    const tail = parsed.match[1].slice(start, end).endsWith("\n") ? eol : "";
    return {
      from: offset + start,
      to: offset + end,
      insert: serialized + tail,
    };
  }
  const from = offset + parsed.match[1].length;
  return { from, to: from, insert: `${eol}${key}: ${serialized}` };
}
