# Contributing to `bigquery-mcp`

Contributions are welcome, and they are greatly appreciated!
Every little bit helps, and credit will always be given.

You can contribute in many ways:

# Types of Contributions

## Report Bugs

Report bugs at https://github.com/pvoo/bigquery-mcp/issues

If you are reporting a bug, please include:

- Your operating system name and version.
- Any details about your local setup that might be helpful in troubleshooting.
- Detailed steps to reproduce the bug.

## Fix Bugs

Look through the GitHub issues for bugs.
Anything tagged with "bug" and "help wanted" is open to whoever wants to implement a fix for it.

## Implement Features

Look through the GitHub issues for features.
Anything tagged with "enhancement" and "help wanted" is open to whoever wants to implement it.

### Tool conventions (read before adding or changing a tool)

This is a two-server project sharing one contract, with explicit cost and naming
rules. New tools must respect all three:

1. **Edit the contract first.** Tools live in `contract/tools.json` (the single
   source of truth). Add/change the tool there — `name`, `summary`, `input`,
   `output` — then implement the handler in **both** servers
   (`src/bigquery_mcp/bigquery_tools.py` and `js/src/tools/handlers.ts` +
   `js/src/bigquery.ts`) and run both suites. See `ARCHITECTURE.md`.
2. **Optimize cost in priority order: BigQuery cost → LLM (token) cost →
   latency.** Prefer metadata APIs over queries; if a tool must scan, bound it
   and route it through the `maximum_bytes_billed` cap. Default to minimal
   output, expanding only on `detailed=true`. Don't trade BigQuery or token cost
   for latency. Note a tool's cost profile in its `summary`, and place it
   cheapest-first in the contract.
3. **Follow Google's BigQuery MCP naming.** Match Google's
   [MCP Toolbox](https://googleapis.github.io/genai-toolbox/resources/tools/bigquery/)
   tool names where an equivalent exists (`execute_sql`, `list_dataset_ids`,
   `get_dataset_info`, `list_table_ids`, `get_table_info`, and the advanced
   `forecast`, `analyze_contribution`, `search_catalog`, `ask_data_insights`).
   Only invent a name when Google has none (e.g. `dry_run_query`,
   `vector_search`). Renaming a tool is a breaking change — bump the contract's
   major version.

## Write Documentation

bigquery-mcp could always use more documentation, whether as part of the official docs, in docstrings, or even on the web in blog posts, articles, and such.

## Submit Feedback

The best way to send feedback is to file an issue at https://github.com/pvoo/bigquery-mcp/issues.

If you are proposing a new feature:

- Explain in detail how it would work.
- Keep the scope as narrow as possible, to make it easier to implement.
- Remember that this is a volunteer-driven project, and that contributions
  are welcome :)

# Get Started!

Ready to contribute? Here's how to set up `bigquery-mcp` for local development.
Please note this documentation assumes you already have `uv` and `Git` installed and ready to go.

1. Fork the `bigquery-mcp` repo on GitHub.

2. Clone your fork locally:

```bash
cd <directory_in_which_repo_should_be_created>
git clone git@github.com:YOUR_NAME/bigquery-mcp.git
```

3. Now we need to install the environment. Navigate into the directory

```bash
cd bigquery-mcp
```

Then, install and activate the environment with:

```bash
uv sync
```

4. Install pre-commit to run linters/formatters at commit time:

```bash
uv run pre-commit install
```

5. Create a branch for local development:

```bash
git checkout -b name-of-your-bugfix-or-feature
```

Now you can make your changes locally.

6. Don't forget to add test cases for your added functionality to the `tests` directory.

7. When you're done making changes, check that your changes pass the formatting tests.

```bash
make check
```

Now, validate that all unit tests are passing:

```bash
make test
```

For the JS server, also build and test it:

```bash
cd js && bun install && bun run build && bun run test
```

8. Before raising a pull request you should also run tox.
   This will run the tests across different versions of Python:

```bash
tox
```

This requires you to have multiple versions of python installed.
This step is also triggered in the CI/CD pipeline, so you could also choose to skip this step locally.

9. Commit your changes and push your branch to GitHub:

```bash
git add .
git commit -m "Your detailed description of your changes."
git push origin name-of-your-bugfix-or-feature
```

10. Submit a pull request through the GitHub website.

# Pull Request Guidelines

Before you submit a pull request, check that it meets these guidelines:

1. The pull request should include tests.

2. If the pull request adds functionality, the docs should be updated.
   Put your new functionality into a function with a docstring, and add the feature to the list in `README.md`.

3. If the pull request adds or changes a tool, update `contract/tools.json`
   first, implement it in both servers, and follow the tool conventions above
   (contract-first, cost priority, Google naming).
