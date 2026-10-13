import { test, expect } from "@playwright/test";
import {
  propertyChange,
  readProperties,
} from "../../src/components/editor/properties";
const apply = (
  text: string,
  key: Parameters<typeof propertyChange>[1],
  value: string | string[],
) => {
  const c = propertyChange(text, key, value);
  return text.slice(0, c.from) + c.insert + text.slice(c.to);
};
test("properties preserve unrelated bytes, comments, Unicode and CRLF", () => {
  const source =
    '---\r\n# research metadata\r\ncustom: {keep: "yes"}\r\ntags: [old] # retain comment\r\naliases:\r\n  - "Research, notes"\r\n  - தமிழ்\r\nstatus: Draft\r\n---\r\n# Body\r\nUnchanged text.\r\n';
  let next = apply(source, "tags", ["science", "தமிழ்"]);
  expect(next).toContain('custom: {keep: "yes"}\r\n');
  expect(next).toContain("# retain comment");
  expect(next.endsWith("# Body\r\nUnchanged text.\r\n")).toBe(true);
  next = apply(next, "aliases", ["A, B", "C"]);
  expect(readProperties(next).error).toBe("");
  expect(readProperties(next).values.aliases).toEqual(["A, B", "C"]);
  expect(next).toContain("status: Draft");
});
test("properties reject malformed and unsupported YAML without altering it", () => {
  for (const source of [
    "---\ntags: [broken\n---\nBody",
    "---\ntags: a\ntags: b\n---\nBody",
    "---\nstatus: {nested: yes}\n---\nBody",
    "---\ntags: [a]\nBody",
  ])
    expect(() => apply(source, "status", "Complete")).toThrow();
});
test("properties create frontmatter only on edit and safely quote values", () => {
  const source = "# Body\n";
  expect(readProperties(source).values.tags).toEqual([]);
  const next = apply(source, "source", "https://example.com/a?b=c#d");
  expect(next.endsWith(source)).toBe(true);
  expect(readProperties(next).values.source).toBe(
    "https://example.com/a?b=c#d",
  );
  expect(
    readProperties(
      apply("---\ncustom: yes\n---\nBody", "tags", ["a:b", "#foo"]),
    ).values.tags,
  ).toEqual(["a:b", "#foo"]);
});
