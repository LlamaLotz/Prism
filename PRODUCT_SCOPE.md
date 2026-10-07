# Product focus and compatibility

Prism helps people turn their own notes and sources into connected, searchable knowledge they control. Its core workflow is capture → find → connect → ask → save, supporting knowledge work, research, and study.

## Simplification without removal

Keep core actions easy to reach and group secondary tools behind clearly labeled navigation. Grouping a feature does not disable it or reduce its support. Preserve existing features, user data, saved preferences, shortcuts, and access to Notebook, graph views, and advanced AI configuration. Do not merge storage systems or change AI permissions as part of interface cleanup.

"Notebook" means the Prism-native notebook: the notebook library, its Sources / Chat / Studio workspace, and the study materials generated from selected vault notes. There is one notebook.

## Removed: the Open Notebook integration

The Advanced Notebook — the vendored Open Notebook server (Python runtime, `notebook_*` commands, its own database, upload pipeline, transformations and podcast screens) — has been removed deliberately. It is no longer "planned work", no longer bundled, and is not a candidate for reinstatement under this document.

What this cost, recorded so the trade-off stays visible:

- Open Notebook **sources** (file uploads), **transformations**, and its **podcast/job screens** are gone. Notebook podcast audio generation went with them; podcast artifacts keep their transcript and any audio already saved.
- Study-material **export** was implemented by running the bundled Python, so only podcast audio (`.mp3`, plain Rust copy) still exports. Other formats report the missing runtime instead of failing silently.
- Existing Open Notebook data is **not deleted** — it stays on disk — but Prism no longer reaches it. Conversations previously linked into the chat library keep their rows and remain visible; they adopt Prism's own stored messages and can no longer be refreshed from the server.

## Planned work remains in scope

OpenClaw, the V2 architecture, and study tools remain eligible to continue under their established specifications. This document neither implements nor redefines those projects, and does not claim that planned capabilities have shipped. There is no blanket feature freeze.

## Evaluating additions

For each future addition, document:

- The knowledge, research, or study workflow it improves and evidence of the user need.
- Why existing functionality cannot adequately address that need.
- Its navigation and onboarding impact, plus ongoing maintenance cost.
- How it preserves existing data, privacy choices, and compatibility.

Prefer improving or connecting existing workflows before adding a separate destination. Broad integrations or new product categories need the same justification; their availability alone is not a reason to add them.
