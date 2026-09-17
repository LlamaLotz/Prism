This directory holds generated native runtime payloads. Run
`python3 scripts/build-notebook-runtime.py` with uv 0.10.12 installed, then
`python3 scripts/test-notebook-runtime.py <payload-directory>`.

Payloads are excluded from git and produced by the Notebook runtime workflow.
Release builds require a validated payload matching their target architecture.
