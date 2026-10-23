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
