import type { AnnotationFile } from "../../services/research";

/** Recovery storage is untrusted and must meet the sidecar contract before rendering. */
export function validAnnotationDraft(
  value: unknown,
  documentId: string,
  pages: number,
): value is AnnotationFile {
  if (!value || typeof value !== "object") return false;
  const draft = value as AnnotationFile;
  if (
    draft.version !== 1 ||
    draft.documentId !== documentId ||
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 0 ||
    !Array.isArray(draft.entries) ||
    draft.entries.length > 10000
  )
    return false;
  const ids = new Set<string>();
  return draft.entries.every((a) => {
    if (
      !a ||
      typeof a.id !== "string" ||
      !a.id ||
      new TextEncoder().encode(a.id).length > 100 ||
      ids.has(a.id)
    )
      return false;
    ids.add(a.id);
    return (
      Number.isInteger(a.page) &&
      a.page >= 1 &&
      a.page <= pages &&
      typeof a.text === "string" &&
      new TextEncoder().encode(a.text).length <= 100000 &&
      typeof a.comment === "string" &&
      new TextEncoder().encode(a.comment).length <= 100000 &&
      ["yellow", "green", "blue", "pink"].includes(a.color) &&
      Number.isSafeInteger(a.createdAt) &&
      a.createdAt >= 0 &&
      Number.isSafeInteger(a.updatedAt) &&
      a.updatedAt >= 0 &&
      Array.isArray(a.rects) &&
      a.rects.length > 0 &&
      a.rects.length <= 1000 &&
      a.rects.every(
        (r) =>
          Array.isArray(r) &&
          r.length === 4 &&
          r.every(
            (n) =>
              typeof n === "number" &&
              Number.isFinite(n) &&
              Math.abs(n) <= 1_000_000,
          ),
      )
    );
  });
}
