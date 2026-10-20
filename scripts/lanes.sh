#!/usr/bin/env bash
#
# Lane integration helper for Prism.
#
# Worktrees and branches:
#   main                    -> this checkout (integration)
#   feature/agent-frontend  -> ../Prism-agent-frontend  (UI lane)
#   feature/agent-backend   -> ../Prism-agent-backend   (Rust lane)
#
# The agents are denied `git push` and `git merge`; this script is for the human.
#
# Usage:
#   scripts/lanes.sh status
#   scripts/lanes.sh merge frontend [--verify=quick|full|none] [--no-push] [--yes]
#   scripts/lanes.sh merge backend  [...]
#   scripts/lanes.sh merge all      [...]
#   scripts/lanes.sh sync [frontend|backend|all]
#   scripts/lanes.sh contract [<sha>]
#
# Global flags:
#   --dry-run          Print commands without running them.
#   --no-push          Merge locally, do not push.
#   --yes, -y          Do not ask for confirmation.
#   --keep-conflicts   Leave a conflicted merge in place instead of aborting.
#   --verify=quick     tsc / cargo check (default).
#   --verify=full      Playwright / cargo test.
#   --verify=none      Skip checks.

set -euo pipefail

FRONTEND_BRANCH="feature/agent-frontend"
BACKEND_BRANCH="feature/agent-backend"

DRY_RUN=false
NO_PUSH=false
ASSUME_YES=false
KEEP_CONFLICTS=false
VERIFY="quick"

die() { printf 'error: %b\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

run() {
  if $DRY_RUN; then
    printf '  [dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

confirm() {
  $DRY_RUN && return 0
  $ASSUME_YES && return 0
  local reply
  read -r -p "$1 [y/N] " reply
  [[ $reply =~ ^[Yy]$ ]]
}

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || die "not inside a git repository"
}

# Print the worktree path currently checked out on <branch>.
worktree_for_branch() {
  git -C "$REPO_ROOT" worktree list --porcelain | awk -v b="refs/heads/$1" '
    /^worktree / { wt = substr($0, 10) }
    /^branch / { if ($2 == b) { print wt; exit } }
  '
}

require_clean() {
  local wt=$1
  [[ -n $wt && -d $wt ]] || die "worktree not found: $wt"
  if [[ -n "$(git -C "$wt" status --porcelain)" ]]; then
    die "worktree is dirty: $wt (commit or stash first)"
  fi
}

prepare_main() {
  require_clean "$MAIN_WT"
  local current
  current=$(git -C "$MAIN_WT" branch --show-current)
  [[ $current == "main" ]] || die "main worktree is on '$current'; switch it to main first"
  run git -C "$MAIN_WT" fetch origin
  run git -C "$MAIN_WT" pull --ff-only origin main
}

ahead_count() {
  git -C "$MAIN_WT" rev-list --count "main..$1"
}

verify_lane() {
  local lane=$1 wt=$2 cmd dir=$2
  case "$VERIFY" in
    none) return 0 ;;
    quick)
      if [[ $lane == frontend ]]; then cmd='npx tsc --noEmit'; else cmd='cargo check'; fi
      ;;
    full)
      if [[ $lane == frontend ]]; then
        cmd='npx tsc --noEmit && npx playwright test'
      else
        cmd='cargo test'
      fi
      ;;
    *) die "invalid --verify mode: $VERIFY (use quick, full, or none)" ;;
  esac
  [[ $lane == backend ]] && dir="$wt/src-tauri"
  if $DRY_RUN; then
    printf '  [dry-run] (cd %s && %s)\n' "$dir" "$cmd"
    return 0
  fi
  ( cd "$dir" && eval "$cmd" )
}

status_cmd() {
  local wt current dirty counts behind ahead
  say "repo: $REPO_ROOT"

  wt=$MAIN_WT
  current=$(git -C "$wt" branch --show-current)
  dirty=clean
  [[ -n "$(git -C "$wt" status --porcelain)" ]] && dirty=dirty
  counts=$(git -C "$wt" rev-list --left-right --count "origin/main...main" 2>/dev/null || true)
  if [[ -n $counts ]]; then
    IFS=$'\t' read -r behind ahead <<< "$counts"
    say "$(printf '%-10s %-6s %s ahead / %s behind origin/main' "main" "$dirty" "$ahead" "$behind")"
  else
    say "$(printf '%-10s %-6s (origin/main not available)' "main" "$dirty")"
  fi
  [[ $current == "main" ]] || say "WARNING: main worktree is checked out on '$current'"

  local lane branch
  for lane in frontend backend; do
    if [[ $lane == frontend ]]; then branch=$FRONTEND_BRANCH; else branch=$BACKEND_BRANCH; fi
    wt=$(worktree_for_branch "$branch")
    if [[ -z $wt ]]; then
      say "$(printf '%-10s %-6s no worktree for %s' "$lane" "-" "$branch")"
      continue
    fi
    dirty=clean
    [[ -n "$(git -C "$wt" status --porcelain)" ]] && dirty=dirty
    counts=$(git -C "$wt" rev-list --left-right --count "main...$branch")
    IFS=$'\t' read -r behind ahead <<< "$counts"
    say "$(printf '%-10s %-6s %s ahead / %s behind main   %s' "$lane" "$dirty" "$ahead" "$behind" "$wt")"
  done
}

merge_lane() {
  local lane=$1 branch=$2 wt n action
  if [[ $lane == frontend ]]; then branch=$FRONTEND_BRANCH; else branch=$BACKEND_BRANCH; fi
  wt=$(worktree_for_branch "$branch")
  [[ -n $wt ]] || die "no worktree found for $branch"

  require_clean "$wt"
  prepare_main
  n=$(ahead_count "$branch")
  if (( n == 0 )); then
    say "$branch has no commits ahead of main; nothing to merge"
    return 0
  fi

  # The frontend must never edit the contract.
  if [[ $lane == frontend ]] && ! git -C "$wt" diff --quiet main...HEAD -- docs/IPC_CONTRACT.md; then
    die "$branch changes docs/IPC_CONTRACT.md; only the backend lane may edit it"
  fi

  # A backend contract change must be promoted alone before backend code lands.
  if [[ $lane == backend ]] && ! git -C "$wt" diff --quiet main...HEAD -- docs/IPC_CONTRACT.md; then
    die "$branch changes docs/IPC_CONTRACT.md; promote it first with: scripts/lanes.sh contract"
  fi

  action="Merge $branch into main"
  $NO_PUSH || action+=" and push"
  confirm "$action?"
  verify_lane "$lane" "$wt"

  $NO_PUSH || run git -C "$wt" push -u origin "$branch"

  if ! run git -C "$MAIN_WT" merge --no-ff "$branch" -m "merge($lane): $branch"; then
    if $KEEP_CONFLICTS; then
      die "merge conflict; resolve it in $MAIN_WT"
    fi
    git -C "$MAIN_WT" merge --abort >/dev/null 2>&1 || true
    die "merge conflict; aborted. Re-run with --keep-conflicts to resolve in place"
  fi

  $NO_PUSH || run git -C "$MAIN_WT" push origin main
  say "Merged $branch."
  say "Before the next task on the other lane run: scripts/lanes.sh sync <lane>"
}

sync_lane() {
  local branch=$1 wt
  wt=$(worktree_for_branch "$branch")
  [[ -n $wt ]] || die "no worktree found for $branch"
  require_clean "$wt"

  run git -C "$wt" fetch origin
  if git -C "$wt" merge-base --is-ancestor origin/main HEAD; then
    say "$branch already contains origin/main"
    return 0
  fi
  if ! run git -C "$wt" merge --no-edit origin/main; then
    git -C "$wt" merge --abort >/dev/null 2>&1 || true
    die "sync conflict in $wt; merge aborted"
  fi
  say "$branch synced with origin/main"
}

contract_cmd() {
  local sha=${1:-} wt files
  wt=$(worktree_for_branch "$BACKEND_BRANCH")
  [[ -n $wt ]] || die "no worktree found for $BACKEND_BRANCH"
  require_clean "$wt"
  prepare_main

  if [[ -z $sha ]]; then
    sha=$(git -C "$wt" log -1 --format=%H "$BACKEND_BRANCH" --not main -- docs/IPC_CONTRACT.md)
  fi
  [[ -n $sha ]] || die "no contract commit ahead of main found on $BACKEND_BRANCH"

  git -C "$wt" merge-base --is-ancestor "$sha" "$BACKEND_BRANCH" \
    || die "$sha is not on $BACKEND_BRANCH"

  files=$(git -C "$wt" show --pretty=format: --name-only "$sha" | sed '/^$/d')
  if [[ $files != "docs/IPC_CONTRACT.md" ]]; then
    die "commit $sha touches more than docs/IPC_CONTRACT.md:\n$files"
  fi

  if git -C "$MAIN_WT" diff --quiet "$sha" main -- docs/IPC_CONTRACT.md; then
    say "main already has the contract content from $sha; nothing to do"
    return 0
  fi

  confirm "Cherry-pick contract commit $sha onto main?"
  if ! run git -C "$MAIN_WT" cherry-pick "$sha"; then
    git -C "$MAIN_WT" cherry-pick --abort >/dev/null 2>&1 || true
    die "contract cherry-pick conflicted; aborted"
  fi
  $NO_PUSH || run git -C "$MAIN_WT" push origin main
  say "Contract promoted."
  say "Now run: scripts/lanes.sh sync all"
}

# --- main -------------------------------------------------------------------

REPO_ROOT=$(repo_root)
MAIN_WT=$(worktree_for_branch main)
[[ -n $MAIN_WT ]] || die "could not find the main worktree"

POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --dry-run)          DRY_RUN=true ;;
    --no-push)          NO_PUSH=true ;;
    --yes|-y)           ASSUME_YES=true ;;
    --keep-conflicts)   KEEP_CONFLICTS=true ;;
    --verify=quick|--verify=full|--verify=none) VERIFY="${arg#--verify=}" ;;
    --verify=*)         die "invalid --verify value: ${arg#--verify=}" ;;
    -h|--help)          usage; exit 0 ;;
    --*)                die "unknown option: $arg" ;;
    *)                  POSITIONAL+=("$arg") ;;
  esac
done

COMMAND=${POSITIONAL[0]:-help}
TARGET=${POSITIONAL[1]:-}

case "$COMMAND" in
  status)
    status_cmd
    ;;
  merge)
    case "$TARGET" in
      frontend|ui) merge_lane frontend "$FRONTEND_BRANCH" ;;
      backend|api|rust) merge_lane backend "$BACKEND_BRANCH" ;;
      all)
        merge_lane frontend "$FRONTEND_BRANCH"
        merge_lane backend "$BACKEND_BRANCH"
        ;;
      *) die "usage: scripts/lanes.sh merge <frontend|backend|all>" ;;
    esac
    ;;
  sync)
    case "${TARGET:-all}" in
      frontend|ui) sync_lane "$FRONTEND_BRANCH" ;;
      backend|api|rust) sync_lane "$BACKEND_BRANCH" ;;
      all)
        require_clean "$(worktree_for_branch "$FRONTEND_BRANCH")"
        require_clean "$(worktree_for_branch "$BACKEND_BRANCH")"
        sync_lane "$FRONTEND_BRANCH"
        sync_lane "$BACKEND_BRANCH"
        ;;
      *) die "usage: scripts/lanes.sh sync [frontend|backend|all]" ;;
    esac
    ;;
  contract)
    contract_cmd "$TARGET"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    die "unknown command: $COMMAND (try: scripts/lanes.sh help)"
    ;;
esac
