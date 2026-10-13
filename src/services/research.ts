import { convertFileSrc, invoke } from "@tauri-apps/api/core";
export interface ResearchAsset {
  handle: string;
  size: number;
  mime: string;
  name: string;
  documentId: string | null;
}
export interface PdfAnnotation {
  id: string;
  page: number;
  rects: [number, number, number, number][];
  text: string;
  comment: string;
  color: string;
  createdAt: number;
  updatedAt: number;
}
export interface AnnotationFile {
  version: number;
  documentId: string;
  revision: number;
  entries: PdfAnnotation[];
}
export interface PdfRequest {
  documentId?: string;
  blockId?: string;
  attachmentHandle?: string;
  page?: number;
  annotation?: string;
}
export const research = {
  asset: (notePath: string, target: string) =>
    invoke<ResearchAsset>("research_asset", { notePath, target }),
  close: (handle: string) => invoke<void>("research_close", { handle }),
  read: async (handle: string, offset: number, length: number) =>
    new Uint8Array(
      await invoke<ArrayBuffer>("research_read", { handle, offset, length }),
    ),
  url: (handle: string) => convertFileSrc(handle, "prism-media"),
  open: (request: PdfRequest = {}, relink = false) =>
    invoke<ResearchAsset | null>("research_open_pdf", {
      documentId: request.documentId ?? null,
      blockId: request.blockId ?? null,
      attachmentHandle: request.attachmentHandle ?? null,
      relink,
    }),
  annotations: (asset: ResearchAsset) =>
    invoke<AnnotationFile>("research_annotations", {
      handle: asset.handle,
      documentId: asset.documentId,
    }),
  save: (asset: ResearchAsset, revision: number, entries: PdfAnnotation[]) =>
    invoke<AnnotationFile>("research_save_annotations", {
      handle: asset.handle,
      documentId: asset.documentId,
      expectedRevision: revision,
      entries,
    }),
  attach: async (notePath: string, file?: File) => {
    if (file && file.size > 16 * 1024 * 1024)
      throw new Error(
        "For attachments over 16 MiB, use Insert attachment to select the file.",
      );
    return invoke<string | null>("research_import_attachment", {
      notePath,
      name: file?.name ?? null,
      bytes: file ? Array.from(new Uint8Array(await file.arrayBuffer())) : null,
    });
  },
};
export function openPdf(request: PdfRequest = {}) {
  window.dispatchEvent(new CustomEvent("prism-open-pdf", { detail: request }));
}
export function parsePdfLink(href: string): PdfRequest | null {
  const match = /^prism-pdf:([a-f0-9]{64})(?:\?(.*))?$/i.exec(href);
  if (!match) return null;
  const args = new URLSearchParams(match[2]);
  return {
    documentId: match[1],
    page: Math.max(1, Number(args.get("page")) || 1),
    annotation: args.get("annotation") || undefined,
  };
}
