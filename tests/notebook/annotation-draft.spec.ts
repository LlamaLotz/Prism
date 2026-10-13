import { test, expect } from "@playwright/test";
import { validAnnotationDraft } from "../../src/components/editor/annotationDraft";

test("recovery rejects malformed, mismatched, duplicate and out-of-bounds annotations", () => {
  const id = "a".repeat(64);
  const annotation = {
    id: "one",
    page: 1,
    rects: [[10, 20, 30, 40]],
    text: "Evidence",
    comment: "தமிழ்",
    color: "yellow",
    createdAt: 1,
    updatedAt: 2,
  };
  const draft = {
    version: 1,
    documentId: id,
    revision: 0,
    entries: [annotation],
  };
  expect(validAnnotationDraft(draft, id, 2)).toBe(true);
  for (const invalid of [
    null,
    {},
    { ...draft, documentId: "b".repeat(64) },
    { ...draft, revision: -1 },
    { ...draft, revision: 1.5 },
    { ...draft, entries: [annotation, annotation] },
    ...[
      { page: 3 },
      { rects: [[0, 0, Infinity, 0]] },
      { rects: [[0, 0, 1]] },
      { rects: [] },
      { text: 17 },
      { comment: null },
      { color: "unknown" },
      { updatedAt: "today" },
      { id: "" },
    ].map((change) => ({ ...draft, entries: [{ ...annotation, ...change }] })),
  ])
    expect(validAnnotationDraft(invalid, id, 2)).toBe(false);
});
