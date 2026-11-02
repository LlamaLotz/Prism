# Prism IPC Contract

Single source of truth for Tauri command payloads. Owned by the backend lane.
Frontend is read-only here. Every change ships through main.

## Conventions

- Registered in `src-tauri/src/lib.rs` with `#[tauri::command]`; command names are `snake_case`.
- Args: single `request: <Type>` object unless noted. Errors: `Result<T, String>`.
- TypeScript mirrors live in `src/types/index.ts`.

## Commands

### example_command

- Status: draft
- Rust: `fn example_command(request: ExampleRequest) -> Result<ExampleResponse, String>`
- Request: `{ "noteId": "string", "limit": 20 }`
- Response: `{ "items": [...] } `

### get_structure_model_status

- Status: draft
- Rust: `fn get_structure_model_status(app: AppHandle) -> Result<StructureModelStatus, String>`
- Request: none (`invoke('get_structure_model_status')`)
- Response:

```json
{
  "state": "ready",
  "model": "LFM2.5-1.2B-Instruct-Q4_K_M",
  "modelPath": "/…/models/LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
  "memoryLimitMb": 2048,
  "contextTokens": 8192,
  "threads": 2,
  "message": "Local structure model is ready."
}
```

- `state`: `ready` | `missing` | `invalid` | `unavailable`
- `modelPath`: `string | null`
- Never loads the model. Reports only whether the bundled model and runtime resolve and verify.
- Errors: `MODEL_UNAVAILABLE: …`, `MODEL_INVALID: …`

### inspect_note_structure

- Status: draft
- Rust: `fn inspect_note_structure(request: StructureInspectRequest) -> Result<StructureInspection, String>`
- Request:

```json
{
  "title": "Research notes",
  "content": "# Research notes\n\nIntro…\n\n## Methods\n\n…",
  "maxBlocks": 5000
}
```

- Response:

```json
{
  "title": "Research notes",
  "blocks": [
    {
      "id": "b0",
      "kind": "heading",
      "level": 2,
      "text": "## Methods",
      "startLine": 5,
      "endLine": 5
    }
  ],
  "outline": [
    {
      "id": "b0",
      "title": "Methods",
      "level": 2,
      "startBlock": "b0",
      "endBlock": "b4",
      "children": []
    }
  ],
  "splitOptions": [
    {
      "mode": "headings",
      "level": 2,
      "sections": 4,
      "label": "Heading 2 · 4 sections"
    },
    {
      "mode": "paragraph",
      "level": null,
      "sections": 6,
      "label": "Paragraph chunks · 6 sections"
    }
  ],
  "warnings": []
}
```

- `blocks[].kind`: `heading` | `paragraph` | `list` | `table` | `code` | `quote` | `media` | `text`
- `outline[].children` recursive; `startBlock`/`endBlock` are inclusive block IDs.
- `maxBlocks` clamps to `1..=20000`; exceeding it returns `LIMIT: …`.
- Deterministic; never calls the model.
- Errors: `LIMIT: …`, `INVALID_INPUT: …`

### plan_note_split

- Status: draft
- Rust: `fn plan_note_split(request: NoteSplitRequest) -> Result<NoteSplitPlan, String>`
- Request:

```json
{
  "title": "Research notes",
  "content": "# Research notes\n\nIntro…",
  "mode": "auto",
  "level": null,
  "targetChars": 6000,
  "existingPaths": ["/vault/Research notes.md"],
  "allowModel": true
}
```

- `mode`: `auto` | `headings` | `paragraph` | `topics`
- `level`: required only for `headings`; `1..=6`; ignored otherwise.
- `targetChars`: optional paragraph/topic target, clamped `500..=50000`; default `6000`.
- `allowModel`: optional, default `true`; `topics` requires the local model. When the model is unavailable, `topics` falls back to deterministic auto and reports a warning.
- Response:

```json
{
  "mode": "auto",
  "level": 2,
  "modelUsed": false,
  "parentContent": "# Research notes\n\nIntro…\n\n## Sections\n\n- [[Methods]]\n",
  "sections": [
    {
      "title": "Methods",
      "fileName": "Methods",
      "content": "# Methods\n\n> Part of [[Research notes]] · Section 1 of 4\n\n…\n\n[[Research notes]]\n",
      "startBlock": "b5",
      "endBlock": "b12"
    }
  ],
  "warnings": [],
  "stats": {
    "blocks": 18,
    "sections": 4,
    "modelMs": 0
  }
}
```

- `parentContent` keeps frontmatter and intro content, then appends a `## Sections` link index.
- `sections[].fileName` has no `.md` extension and is de-duplicated against `existingPaths` and earlier sections.
- `sections[].content` starts with an H1 (the section title), then a parent breadcrumb/backlink. Original block text is preserved inside the section; the boundary heading block is rendered as that H1 rather than duplicated.
- `topics` may only propose block boundaries and relative heading levels. Rust validates coverage and never accepts generated note text.
- Errors:
  - `INVALID_INPUT: …`
  - `LIMIT: …`
  - `MODEL_UNAVAILABLE: …`
  - `MODEL_INVALID: …`
  - `TIMEOUT: …`
  - `INVALID_OUTPUT: …` (model output failed structural validation)
  - `CONFLICT: …` (content changed or plan no longer valid)

