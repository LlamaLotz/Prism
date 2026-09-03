Hi there! Prism is an app that is a Personal Knowledge Manager or PKM. It was primarily built for students but can be used by anyone.
This is a much larger project and has many more updates to come in the near future. This project is still under active construction.

It used to study, research, much will do SO much more in future
The best thing is, it will stay FREE, FOREVER. It was made to solve an issue I had with studying so I built it to help me and give me a new experience in building apps.

## Signed Updates

Prism uses the Tauri updater with signed artifacts published to GitHub Releases.

Before publishing a release, add these GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: the complete contents of `myapp.key` (never commit this file or paste it into source code)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the key password, or an empty secret if the key has no password

The public key is embedded in `src-tauri/tauri.conf.json`. The release workflow runs when a `v*` tag is pushed, creates signed NSIS/MSI and macOS updater artifacts, and uploads `latest.json` to the release. Increase `version` in `src-tauri/tauri.conf.json` before creating each release tag; the version must be greater than the installed version for the updater to offer it.

For a local signed build, set `TAURI_SIGNING_PRIVATE_KEY` and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the shell environment before running `npm run build`. Do not put the private key in `.env`, `package.json`, GitHub Actions logs, or the repository.
