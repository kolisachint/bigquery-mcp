---
description: Bump the version (patch|minor|major) across both packages, run all quality gates, and open a release PR with the correct label.
argument-hint: [patch|minor|major]
allowed-tools: Bash(git:*), Bash(gh:*), Bash(make:*), Bash(uv:*), Bash(bun:*), Bash(grep:*), Bash(sed:*), Edit, Read
---

# /pr — cut a release pull request

Bump level (SemVer): **$ARGUMENTS** — one of `patch`, `minor`, or `major`.
If empty, default to `patch`. If it is anything else, stop and tell the user the
valid values.

## Context (this repo)

- Three files must be bumped **in lockstep** (all must match):
  1. `pyproject.toml` → `version = "X.Y.Z"`
  2. `src/bigquery_mcp/__init__.py` → `__version__ = "X.Y.Z"`
  3. `js/package.json` → `"version": "X.Y.Z"`
- After bumping `pyproject.toml`, run `uv lock` to keep `uv.lock` in sync.
- `contract/tools.json` → `contractVersion` is **independent** of the release
  version (it tracks the shared tool contract). Do **not** bump it here unless the
  user explicitly asks; if tools changed, remind them it may need a separate bump.
- Default branch: `master`. Remote: `origin` (`kolisachint/bigquery-mcp`).
- **Release gating:** The release workflow (`.github/workflows/release.yml`) is
  label-driven. The PR **must** carry a `release:<level>` label or the entire
  publish pipeline (PyPI, npm, GitHub Release) will be skipped on merge.

## Steps

1. **Preflight.** Run `git status --porcelain`. If the tree is dirty, stop and ask
   the user whether to proceed (uncommitted changes would be swept into the PR).
   Confirm `gh auth status` succeeds; if not, tell the user to run `gh auth login`.
   Confirm the current branch is `master` and it is up to date with `origin/master`
   (`git pull --ff-only origin master`).

2. **Read current version** from `pyproject.toml` (line ~3). Confirm all three files
   agree:
   - `pyproject.toml` → `version = "X.Y.Z"`
   - `src/bigquery_mcp/__init__.py` → `__version__ = "X.Y.Z"`
   - `js/package.json` → `"version": "X.Y.Z"`
   If any disagree, stop and report the drift.

3. **Compute the new version** from the bump level:
   - `patch` → `X.Y.(Z+1)`
   - `minor` → `X.(Y+1).0`
   - `major` → `(X+1).0.0`

4. **Apply the bump** with `Edit` to all three files (keep them identical):
   - `pyproject.toml`: `version = "<old>"` → `version = "<new>"`
   - `src/bigquery_mcp/__init__.py`: `__version__ = "<old>"` → `__version__ = "<new>"`
   - `js/package.json`: `"version": "<old>"` → `"version": "<new>"`

5. **Sync the lockfile.** Run `uv lock` to regenerate `uv.lock` for the new version.

6. **Quality gates — all must pass before opening the PR.** If any fail, fix or
   stop and report; do not open the PR on red.
   - Python: `make check` then `make test`
     - If `make check` fails on the first attempt and pre-commit auto-fixed files
       (check output for "files were modified by this hook"), **re-run** `make check`
       — it should pass on the second run.
   - JS: `cd js && bun install && bun run build && bun run test`

7. **Branch + commit.**
   - `git checkout -b release/v<new>`
   - `git add pyproject.toml src/bigquery_mcp/__init__.py js/package.json uv.lock`
   - `git commit -m "chore(release): v<new>"`

8. **Push + open PR with the release label.**
   - `git push -u origin release/v<new>`
   - Create the PR against `master` **and** apply the `release:<level>` label:
     ```
     gh pr create --base master --head release/v<new> \
       --title "chore(release): v<new>" \
       --label "release:$ARGUMENTS" \
       --body "$(cat <<'EOF'
     ## Release v<new>

     Bump (`$ARGUMENTS`): `<old>` → `<new>`, applied to all three version files
     (`pyproject.toml`, `src/bigquery_mcp/__init__.py`, `js/package.json`).

     ### Checks
     - [x] `make check` (lint, type, format)
     - [x] `make test` (Python)
     - [x] `bun run build && bun run test` (JS)

     ### Notes
     - `uv.lock` regenerated.
     - `contractVersion` (`contract/tools.json`) unchanged.
     - **Release label `release:$ARGUMENTS` applied** — the release workflow will
       trigger on merge.
     EOF
     )"
     If `gh pr create` fails because the label does not exist, create it first:
     `gh label create "release:$ARGUMENTS" --description "Triggers release workflow" --color 0E8A16`

9. **Switch back to master.** `git checkout master`

10. **Report** the new version, the PR URL, and remind the user to merge the PR
    to trigger the release.
