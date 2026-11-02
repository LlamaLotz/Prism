import { invoke } from '@tauri-apps/api/core';

/**
 * Typed wrappers for the offline structure commands documented in
 * `docs/IPC_CONTRACT.md`. Everything here is deterministic except `topics`
 * mode, which may use the optional local model. The model only proposes block
 * boundaries; Rust validates the plan and renders the section text.
 */

export type StructureModelState = 'ready' | 'missing' | 'invalid' | 'unavailable';

export interface StructureModelStatus {
  state: StructureModelState;
  model: string;
  modelPath: string | null;
  memoryLimitMb: number;
  contextTokens: number;
  threads: number;
  message: string;
}

export type StructureBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'code'
  | 'quote'
  | 'media'
  | 'text';

export interface StructureBlock {
  id: string;
  kind: StructureBlockKind;
  level: number | null;
  text: string;
  startLine: number;
  endLine: number;
}

export interface OutlineNode {
  id: string;
  title: string;
  level: number;
  startBlock: string;
  endBlock: string;
  children: OutlineNode[];
}

export type StructureSplitMode = 'auto' | 'headings' | 'paragraph' | 'topics';

export interface SplitOption {
  mode: StructureSplitMode;
  level: number | null;
  sections: number;
  label: string;
}

export interface StructureInspection {
  title: string;
  blocks: StructureBlock[];
  outline: OutlineNode[];
  splitOptions: SplitOption[];
  warnings: string[];
}

export interface StructureInspectRequest {
  title: string;
  content: string;
  maxBlocks?: number;
}

export interface NoteFormatRequest {
  title: string;
  content: string;
}

export interface NoteFormatPreview {
  content: string;
  changed: boolean;
  outline: OutlineNode[];
  warnings: string[];
}

export interface NoteSplitRequest {
  title: string;
  content: string;
  mode: StructureSplitMode;
  level?: number | null;
  targetChars?: number | null;
  existingPaths?: string[];
  allowModel?: boolean;
}

export interface SectionPlan {
  title: string;
  fileName: string;
  content: string;
  startBlock: string;
  endBlock: string;
}

export interface SplitStats {
  blocks: number;
  sections: number;
  modelMs: number;
}

export interface NoteSplitPlan {
  mode: StructureSplitMode;
  level: number | null;
  modelUsed: boolean;
  parentContent: string;
  sections: SectionPlan[];
  warnings: string[];
  stats: SplitStats;
}

export const structure = {
  /** Reports whether the bundled model/runtime resolve and verify; never loads it. */
  modelStatus: () => invoke<StructureModelStatus>('get_structure_model_status'),
  inspect: (request: StructureInspectRequest) =>
    invoke<StructureInspection>('inspect_note_structure', { request }),
  previewFormat: (request: NoteFormatRequest) =>
    invoke<NoteFormatPreview>('preview_note_format', { request }),
  planSplit: (request: NoteSplitRequest) =>
    invoke<NoteSplitPlan>('plan_note_split', { request }),
};

export const STRUCTURE_ERROR_CODES = [
  'INVALID_INPUT',
  'LIMIT',
  'MODEL_UNAVAILABLE',
  'MODEL_INVALID',
  'TIMEOUT',
  'INVALID_OUTPUT',
  'CONFLICT',
] as const;

export type StructureErrorCode = (typeof STRUCTURE_ERROR_CODES)[number] | 'UNKNOWN';

export interface StructureErrorInfo {
  code: StructureErrorCode;
  /** Detail after the `CODE:` prefix, without the prefix itself. */
  detail: string;
  /** Short user-facing summary. */
  title: string;
  /** Action the user can take to recover. */
  action: string;
  /** The raw command error, useful in logs and tests. */
  raw: string;
}

const FALLBACK_COPY: Record<
  Exclude<StructureErrorCode, 'UNKNOWN'>,
  { title: string; action: string }
> = {
  INVALID_INPUT: {
    title: 'That request is not valid for this note.',
    action: 'Adjust the note or split choices, then try again.',
  },
  LIMIT: {
    title: 'This note is too large for that operation.',
    action: 'Use a smaller selection, or split the note into smaller parts first.',
  },
  MODEL_UNAVAILABLE: {
    title: 'The local structure model is unavailable.',
    action: 'Use Headings, Auto, or Paragraph, or stage the model to use Topics.',
  },
  MODEL_INVALID: {
    title: 'The local structure model failed its validation check.',
    action: 'Reinstall the structure model, or use a deterministic split mode.',
  },
  TIMEOUT: {
    title: 'The local structure model timed out.',
    action: 'Try Topics again, or use Headings, Auto, or Paragraph.',
  },
  INVALID_OUTPUT: {
    title: 'The structure plan failed validation.',
    action: 'Refresh the preview, or use a deterministic split mode.',
  },
  CONFLICT: {
    title: 'The note changed while this preview was being built.',
    action: 'Refresh the preview and review the new plan before applying it.',
  },
};

const KNOWN_CODES = new Set<string>(STRUCTURE_ERROR_CODES);

/** Turns a Tauri command rejection into a stable, actionable error model. */
export function parseStructureError(error: unknown): StructureErrorInfo {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : error == null
          ? 'Unknown error'
          : String(error);

  const match = raw.trim().match(/^([A-Z_]+)\s*:\s*([\s\S]*)$/);
  if (!match || !KNOWN_CODES.has(match[1])) {
    return {
      code: 'UNKNOWN',
      detail: raw.trim(),
      title: 'The structure command failed.',
      action: 'Try again. Your note was not changed.',
      raw,
    };
  }

  const code = match[1] as Exclude<StructureErrorCode, 'UNKNOWN'>;
  const detail = match[2].trim();
  return {
    code,
    detail,
    title: FALLBACK_COPY[code].title,
    action: FALLBACK_COPY[code].action,
    raw,
  };
}
