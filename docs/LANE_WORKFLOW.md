# Lane Workflow

How the UI and backend agents work in parallel, and how their work reaches
`main` without stepping on each other.

## The lanes

| Lane | Agent | Worktree | Branch | Owns |
| --- | --- | --- | --- | --- |
| UI | `frontend` | `../Prism-agent-frontend` | `feature/agent-frontend` | `src/**`, `index.html`, frontend config, `tests/**` |
| Backend | `backend` | `../Prism-agent-backend` | `feature/agent-backend` | `src-tauri/**`, `docs/IPC_CONTRACT.md` |
| Integration | — | this checkout | `main` | merges, pushes, PRs, releases |

The two feature branches are file-disjoint, so ordinary UI and Rust changes
merge cleanly. The one shared file is `docs/IPC_CONTRACT.md`, which only the
backend lane may edit.

Agents never push or merge. That is the human's job, done from the main
checkout with `scripts/lanes.sh`.

## The integration script

`scripts/lanes.sh` resolves all worktrees via `git worktree list`, so it works
from any folder in the repo. Run it from the main checkout by convention.

```sh
scripts/lanes.sh status
scripts/lanes.sh merge frontend
scripts/lanes.sh merge backend
scripts/lanes.sh merge all
scripts/lanes.sh sync
scripts/lanes.sh contract [<sha>]
```

Flags:

| Flag | Effect |
| --- | --- |
| `--verify=quick` | `npx tsc --noEmit` / `cargo check` (default) |
| `--verify=full` | `npx playwright test` / `cargo test` |
| `--verify=none` | Skip checks |
| `--dry-run` | Print commands, change nothing |
| `--no-push` | Merge locally, do not push |
| `--yes`, `-y` | Skip the confirmation prompt |
| `--keep-conflicts` | Leave a conflicted merge in place instead of aborting |

`merge` only touches the finished lane and `main`. It does **not** sync the
other worktree, because that agent may still be running. Syncing is explicit.

## Checklist

### Pre-merge — always

- [ ] The finished agent has stopped; no more edits are happening.
- [ ] That worktree is clean:
  ```sh
  git -C ~/projects/Prism-agent-frontend status
  ```
  (or `...-backend`)
- [ ] The main checkout is on `main` and clean.
- [ ] Overall state:
  ```sh
  cd ~/projects/Prism
  scripts/lanes.sh status
  ```
- [ ] Review what the agent actually did:
  ```sh
  git -C ~/projects/Prism-agent-frontend log --oneline main..HEAD
  git -C ~/projects/Prism-agent-frontend diff --stat main...HEAD
  ```
- [ ] Confirm its test results from the run report. If unsure, rerun the checks.

### If only one branch finished

- [ ] **Contract rule:** if the finished branch is backend and it changed
      `docs/IPC_CONTRACT.md`, promote the contract first:
  ```sh
  scripts/lanes.sh contract
  ```
- [ ] Merge that lane:
  ```sh
  scripts/lanes.sh merge frontend    # or: merge backend
  ```
- [ ] Confirm the output: checks passed, feature branch pushed, `main` merged
      and pushed.
- [ ] Check GitHub: `main` contains the merge; the feature branch is current.
- [ ] Before the next task on the *other* lane:
  ```sh
  scripts/lanes.sh sync
  ```
- [ ] If the branch is finished permanently, delete it (optional; not automatic).

Do not wait for both branches. If UI is ready and backend is still working,
merge UI now.

### If both branches finished

- [ ] Both agents stopped; both worktrees clean.
- [ ] Contract change? Run `scripts/lanes.sh contract` first.
- [ ] Merge both:
  ```sh
  scripts/lanes.sh merge all
  ```
- [ ] Verify `main` on GitHub and run the app once (or the full suite if the
      merge was non-trivial).
- [ ] Before new work:
  ```sh
  scripts/lanes.sh sync
  ```
- [ ] Optional cleanup: delete the finished branches locally and on GitHub.

### If the merge conflicts

- [ ] Do **not** force push or hand-edit around the conflict.
- [ ] The script aborts the merge and names the conflicting files.
- [ ] Resolve in the main checkout:
  ```sh
  git status
  # edit the conflicted files
  git add <files>
  git commit
  ```
- [ ] Rerun the relevant checks, then:
  ```sh
  git push
  scripts/lanes.sh sync
  ```

## Never

- Merge while an agent is still editing that branch.
- Merge `feature/agent-backend` into `feature/agent-frontend` (or vice versa).
  Always go through `main`.
- Let an agent run the integration script — that is the human's job.
- Force push.

## The loop

```
sync -> launch agents -> wait for finish -> review -> merge -> sync
```

Launch order does not matter, except for the contract: a contract change must
be promoted and synced before frontend work depends on it.
