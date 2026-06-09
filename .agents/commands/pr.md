---
description: Bump the version (patch|minor|major) across both packages, run all quality gates, and open a release PR.
argument-hint: [patch|minor|major]
allowed-tools: Bash(git:*), Bash(gh:*), Bash(make:*), Bash(uv:*), Bash(bun:*), Bash(grep:*), Bash(sed:*), Edit, Read
---

# /pr — cut a release pull request

Bump level (SemVer): **$ARGUMENTS** — one of `patch`, `minor`, or `major`.
If empty, default to `patch`. If it is anything else, stop and tell the user the
valid values.

## Context (this repo)

- Two packages are released together and **must share the same version**:
  - Python: `pyproject.toml` → `version = "X.Y.Z"`
  - JS: `js/package.json` → `"version": "X.Y.Z"`
- `contract/tools.json` → `contractVersion` is **independent** of the release
  version (it tracks the shared tool contract). Do **not** bump it here unless the
  user explicitly asks; if tools changed, remind them it may need a separate bump.
- Default branch: `master`. Remote: `origin` (`kolisachint/bigquery-mcp`).

## Steps

1. **Preflight.** Run `git status --porcelain`. If the tree is dirty, stop and ask
   the user whether to proceed (uncommitted changes would be swept into the PR).
   Confirm `gh auth status` succeeds; if not, tell the user to run `gh auth login`.

2. **Read current version** from `pyproject.toml` (line ~3) and confirm
   `js/package.json` matches it. If they disagree, stop and report the drift.

3. **Compute the new version** from the bump level:
   - `patch` → `X.Y.(Z+1)`
   - `minor` → `X.(Y+1).0`
   - `major` → `(X+1).0.0`

4. **Apply the bump** with `Edit` to both files (keep them identical):
   - `pyproject.toml`: `version = "<old>"` → `version = "<new>"`
   - `js/package.json`: `"version": "<old>"` → `"version": "<new>"`

5. **Quality gates — all must pass before opening the PR.** If any fail, fix or
   stop and report; do not open the PR on red.
   - Python: `make check` then `make test`
   - JS: `cd js && bun install && bun run build && bun run test`

6. **Branch + commit.**
   - `git checkout -b release/v<new>`
   - `git add pyproject.toml js/package.json`
   - `git commit -m "chore(release): v<new>"`

7. **Push + open PR.**
   - `git push -u origin release/v<new>`
   - Create the PR against `master`:
     ```
     gh pr create --base master --head release/v<new> \
       --title "chore(release): v<new>" \
       --body "$(cat <<'EOF'
     ## Release v<new>

     Bump (`$ARGUMENTS`): `<old>` → `<new>`, applied to both packages
     (`pyproject.toml` and `js/package.json`).

     ### Checks
     - [x] `make check` (lint, type, format)
     - [x] `make test` (Python)
     - [x] `bun run build && bun run test` (JS)

     ### Notes
     - `contractVersion` (`contract/tools.json`) unchanged.
     EOF
     )"
     ```

8. **Report** the new version and the PR URL that `gh` printed.
