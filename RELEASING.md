# Releasing

Releases are **label-driven** and publish both packages in lockstep:

| Package | Registry | Auth |
|---|---|---|
| `bigquery-mcp` (Python) | PyPI | Trusted Publishing (OIDC, `pypi` environment) |
| `bigquery-mcp-js` (JS) | npm | `NPM_TOKEN` repository secret |

## How to cut a release

1. Open a PR and add **one** label:
   - `release:patch` → `x.y.Z+1`
   - `release:minor` → `x.Y+1.0`
   - `release:major` → `X+1.0.0`
2. Merge the PR into the default branch.

The [`Release` workflow](.github/workflows/release.yml) then:

1. Determines the bump level from the label.
2. Runs the Python and JS quality gates.
3. Bumps the version in lockstep across `pyproject.toml`,
   `src/bigquery_mcp/__init__.py`, and `js/package.json`
   (via `bun scripts/bump-version.ts`), commits, and tags it.
4. Publishes to PyPI (Trusted Publishing) and npm (`bun publish`).
5. Creates a GitHub Release with generated notes.

A PR merged **without** a `release:*` label does nothing.

## Manual release

Use the **workflow_dispatch** trigger on the Actions tab and pick a bump level
(`patch` / `minor` / `major`).

## One-time setup

- **PyPI**: configure a Trusted Publisher for the `bigquery-mcp` project
  pointing at this repo's `release.yml` / `pypi` environment.
- **npm**: add an automation `NPM_TOKEN` with publish rights as a repository
  secret. The first publish of `bigquery-mcp-js` may need to be done manually
  (`cd js && bun run build && bun publish --access public`) if the name is new.
