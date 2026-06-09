# 🗂️ BigQuery MCP Server

Practical MCP server for navigating BigQuery datasets and tables by LLMs. Designed for larger projects with many datasets/tables, optimized to keep BigQuery spend low and LLM context small while staying fast and safe.

- **Minimal by default**: list datasets and tables names; fetch details only when asked
- **Navigate larger projects**: filter by name, request detailed metadata/schemas on demand
- **Quick table insight**: optional schema, column descriptions and fill-rate to help an agent decide relevance fast
- **Safe to run**: read-only query execution with guardrails (SELECT/WITH only, comment stripping)
- **Cost-bounded by design**: metadata-first discovery, a `dry_run_query` cost estimator, and a hard per-query bytes-billed cap

## 🎯 Optimization priority

Every tool and default in this server is designed around one explicit ordering. When choices conflict, earlier goals win:

1. **Minimize BigQuery cost first** — bytes scanned is what you pay for. Discovery (`list_dataset_ids`, `get_dataset_info`, `list_table_ids`, `get_table_info`) is **metadata-only and scans zero bytes**. `dry_run_query` estimates a query's bytes **without running it**. Every real query (`execute_sql`, `get_table_info` sampling) is capped by `maximum_bytes_billed` (default ~USD 0.50/query). Tool descriptions steer the model to filter on partition/cluster columns, select only needed columns, and use `LIMIT`.
2. **Then minimize LLM (token) cost** — list tools return **names only by default**, switching to full metadata only when `detailed=true`. Responses are compact, structured JSON so the agent spends few tokens deciding what's relevant before paying for a scan.
3. **Then minimize latency** — metadata calls run in threads and time out fast; list+search uses a bounded fetch multiplier. Latency is optimized **only where it doesn't increase BigQuery or token cost**.

See [ARCHITECTURE.md](ARCHITECTURE.md#design-priorities-bigquery-cost--llm-cost--latency) for the mechanisms behind each level.

## 🧭 Tool naming

Tool names follow Google's [BigQuery MCP / MCP Toolbox](https://googleapis.github.io/genai-toolbox/resources/tools/bigquery/) conventions so agents already trained on Google's surface feel at home: `execute_sql`, `list_dataset_ids`, `get_dataset_info`, `list_table_ids`, `get_table_info`. The only tool with no Google equivalent is this project's own addition: `dry_run_query` (pre-flight cost estimate).

> **Two implementations, one contract.** This is the Python server. A standalone
> Node/TypeScript server, [`bigquery-mcp-js`](js/), exposes the **same tools**.
> Both implement a shared contract (`contract/tools.json`); pick whichever fits
> your runtime. See [ARCHITECTURE.md](ARCHITECTURE.md).

## 🧠 Bundled agent skills & agents

Both packages ship portable [Agent Skills](https://code.claude.com/docs) and ready-to-use agent definitions under [`.agents/`](.agents/). Each has a single canonical copy at the repo root that is bundled into both the PyPI and npm distributions (Python under `bigquery_mcp/skills/…` and `bigquery_mcp/agents/…`; npm under `dist/skills/…` and `dist/agents/…`).

**Skills** ([`.agents/skills/`](.agents/skills/)):
- **`bigquery-cost-first-querying`** — teaches an agent to drive these tools cost-first (BigQuery bytes → tokens → latency): tool-selection procedure, query-shaping rules, and anti-patterns. This is the authoritative cost guidance.
- **`secure-context-reducer`** — reduces retrieved data to a compact, prompt-safe fact map with GDPR-style data minimization and PCI-DSS boundaries (no cardholder data in the prompt path); defers the BigQuery half to the cost-first skill.

**Agents** ([`.agents/agents/`](.agents/agents/)):
- **`bigquery-table-analyst`** — explores datasets/tables and reports schemas, fill rates, and relationships, cost-first.
- **`cost-first-compliant-agent`** — queries cost-first, runs results through `secure-context-reducer`, then reasons over the safe facts. Each agent declares the skills it obeys via a `required-skills` frontmatter field.

Point your agent runtime at the files (or copy them into your project's skills/agents directories) to load the guidance.

## Quick Start

**Prerequisites:** Python 3.10+ and [uv](https://github.com/astral-sh/uv) package manager

### 🚀 Quick Setup

**Option 1: Direct from PyPI (Recommended)**
```bash
# 1. Authenticate
gcloud auth application-default login

# 2. Run server
uvx bigquery-mcp-python --project YOUR_PROJECT --location US
```

> **Package name vs. command:** the PyPI package is **`bigquery-mcp-python`** (the
> `uvx`/`pip install` target); the command it installs is **`bigquery-mcp`**.
> `pip install bigquery-mcp` will **not** find this project.

**Option 2: Clone locally (development setup)**
```bash
# 1. Clone and setup
git clone https://github.com/kolisachint/bigquery-mcp.git
cd bigquery-mcp

# 2. Configure environment
cp .env.example .env
# Edit .env with your project and location

# 3. Run or inspect
make run      # Start server
make inspect  # Open MCP inspector
```

### 🔧 MCP Client Configuration

**Option 1: PyPI package (Recommended)**
Simplest setup using the published PyPI package:
```json
{
  "mcpServers": {
    "bigquery": {
      "command": "uvx",
      "args": [
        "bigquery-mcp-python",
        "--project", "your-project-id",
        "--location", "US"
     ]
    }
  }
}
```


**Option 2: Local clone (for development)**
```bash
# Clone first
git clone https://github.com/kolisachint/bigquery-mcp.git
```

```json
{
  "mcpServers": {
    "bigquery": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/bigquery-mcp", "run", "bigquery-mcp"],
      "env": {
        "GCP_PROJECT_ID": "your-project-id",
        "BIGQUERY_LOCATION": "US"
      }
    }
  }
}
```

### 🧪 Test Your Setup

```bash
# Test with MCP inspector
npx @modelcontextprotocol/inspector uvx bigquery-mcp-python --project YOUR_PROJECT --location US
```

## 🔧 Configuration Options

All configuration can be set via CLI arguments or environment variables. CLI arguments take precedence.

### Required Parameters
```bash
--project YOUR_PROJECT    # Google Cloud project ID
--location US             # BigQuery location (US, EU, etc.)
```

### Optional Parameters
```bash
# Dataset Access Control
--datasets dataset1 dataset2    # Restrict to specific datasets (default: all datasets)

# Query & Result Limits
--list-max-results 500          # Max results for basic list operations (default: 500)
--detailed-list-max 25          # Max results for detailed list operations (default: 25)
--max-bytes-billed 109951162777  # Max bytes billed per query job (~USD 0.50/query)

# Table Analysis
--sample-rows 3                 # Sample data rows returned in get_table_info (default: 3)
--stats-sample-size 500         # Rows sampled for column fill rate calculations (default: 500)

# Authentication
--key-file /path/to/key.json    # Service account key file (default: ADC)
```

### Environment Variables
All CLI options have corresponding environment variables:
```bash
export GCP_PROJECT_ID=your-project
export BIGQUERY_LOCATION=US
export BIGQUERY_ALLOWED_DATASETS=dataset1,dataset2
export BIGQUERY_LIST_MAX_RESULTS=500
export BIGQUERY_LIST_MAX_RESULTS_DETAILED=25
export BIGQUERY_MAX_BYTES_BILLED=109951162777
export BIGQUERY_SAMPLE_ROWS=3
export BIGQUERY_SAMPLE_ROWS_FOR_STATS=500
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
```

## 🛠️ Tools Overview

This MCP server provides 6 BigQuery tools, ordered below cheapest-first (no BigQuery cost → bounded cost). Names follow Google's BigQuery MCP conventions.

### 📊 Discovery — metadata only, **scans zero bytes**
- **`list_dataset_ids`** - List dataset names in the project. Dual mode: names only (default) vs `detailed=true` for descriptions + table counts.
- **`get_dataset_info`** - Metadata for one dataset (description, location, labels, table count).
- **`list_table_ids`** - List table names in a dataset. Dual mode: names only (default) vs `detailed=true` for row counts + sizes.
- **`get_table_info`** - Schema, column descriptions, per-column fill rates, and a few sample rows so an agent can judge relevance. The fill-rate/sample probes scan only a small bounded sample (capped by `maximum_bytes_billed`).

### 🔍 Querying — cost-bounded
- **`dry_run_query`** - Estimate the bytes a query would scan **without running it** (zero cost). Run before `execute_sql` on large tables.
- **`execute_sql`** - Execute SELECT/WITH queries only, with cost tracking, safety validation, and a default per-query billing cap of about USD 0.50. The description steers the model to filter on partitions, avoid `SELECT *`, and use `LIMIT`.

**Key Features:**
- ✅ **Cost-first** - Discovery scans zero bytes; `dry_run_query` previews cost; every query is capped by `maximum_bytes_billed`
- ✅ **Minimal by default** - names-only list mode means ~70% fewer tokens before you commit to a scan
- ✅ **Safe queries only** - Blocks all write operations (SELECT/WITH only)
- ✅ **LLM-optimized** - Returns structured data perfect for AI analysis
- ✅ **Cost transparent** - Shows bytes processed for each query
- ✅ **Google-aligned naming** - Matches the Google BigQuery MCP toolset; own tools added only where Google has no equivalent

## 🏗️ Development Setup

### Local Development
```bash
# Clone and setup
git clone https://github.com/kolisachint/bigquery-mcp.git
cd bigquery-mcp
make install  # Setup environment + pre-commit hooks

# Development workflow
make run      # Start server
make test     # Run test suite
make check    # Lint + format + typecheck
make inspect  # Launch MCP inspector
```

### Testing & Quality
```bash
make test                    # Full test suite
pytest tests/test_safety.py  # SQL safety validation tests
pytest tests/test_server.py  # Core server functionality tests
make check                   # Run all quality checks
```

## 🔐 Authentication & Permissions

**Authentication Methods:**
1. **Application Default Credentials** (recommended): `gcloud auth application-default login`
2. **Service Account Key**: Use `--key-file` or set `GOOGLE_APPLICATION_CREDENTIALS`

**Required BigQuery Permissions:**
- `bigquery.datasets.get`, `bigquery.datasets.list`
- `bigquery.tables.list`, `bigquery.tables.get`
- `bigquery.jobs.create`, `bigquery.data.get`

## 🚨 Troubleshooting

**Authentication Issues:**
```bash
# Check current auth
gcloud auth application-default print-access-token

# Re-authenticate
gcloud auth application-default login

# Enable BigQuery API
gcloud services enable bigquery.googleapis.com
```

**MCP Connection Issues:**
- Ensure absolute paths in MCP config
- Test server manually: `make run`
- Check that project and location environment variables or args are set correctly

**Performance Issues:**
- Use `{"detailed": false}` for faster responses
- Add search filters: `{"search": "pattern"}`
- Reduce max_results for large datasets

## 💡 Usage Examples

### 📊 SQL Query Example
```sql
-- Query public datasets
SELECT
    EXTRACT(YEAR FROM pickup_datetime) as year,
    COUNT(*) as trips,
    ROUND(AVG(fare_amount), 2) as avg_fare
FROM `bigquery-public-data.new_york_taxi_trips.tlc_yellow_trips_2020`
WHERE pickup_datetime BETWEEN '2020-01-01' AND '2020-12-31'
GROUP BY year
LIMIT 20
```

### 🤖 Example: Usage with Claude Code subagent

**Scenario:** Use the specialized BigQuery Table Analyst agent in Claude Code to automatically explore your data warehouse, analyze table relationships, and provide structured insights. By using the subagent you can take the context used for analyzing the tables out of the main thread and return actionable insights into the main agent thread for writing SQL or analyzing.

**Setup:**
```bash
# 1. Clone and configure
git clone https://github.com/kolisachint/bigquery-mcp.git
cd bigquery-mcp

# 2. Setup environment
export GCP_PROJECT_ID="your-project-id"
export BIGQUERY_LOCATION="US"
gcloud auth application-default login

# 3. Launch Claude Code
claude-code
```

**Example Usage:**
```
💬 You: "I need to understand our sales data structure and find tables related to customer orders"

🤖 Claude: I'll use the BigQuery Table Analyst agent to explore your sales datasets and identify relevant tables with their relationships.

[Agent automatically:]
- Lists all datasets to identify sales-related ones
- Explores table schemas with detailed metadata
- Shows actual sample data from key tables
- Discovers join relationships between tables
- Provides ready-to-use SQL queries
```

**What the Agent Returns:**
- **Table schemas** with column descriptions and types
- **Sample data** showing actual values (not placeholders)
- **Join relationships** with working SQL examples
- **Data quality insights** (null rates, freshness, etc.)
- **Actionable SQL queries** you can immediately execute



## 🤝 Contributing

We welcome contributions! Looking forward to your feedback for improvements.

**Quick Start:**
```bash
# Fork on GitHub, then:
git clone https://github.com/kolisachint/bigquery-mcp.git
cd bigquery-mcp
make install  # Setup dev environment
make check    # Verify everything works

# Make changes, then:
make test     # Run tests
make check    # Quality checks
# Submit PR!
```

**Development Guidelines:**
- Add tests for new features
- Update documentation
- Follow existing code style (enforced by pre-commit hooks)
- Ensure all quality checks pass

**Found an issue or have a feature request?**
- 🐛 **Bug reports:** [Open an issue](https://github.com/kolisachint/bigquery-mcp/issues)
- 🔧 **Code improvements:** Submit a pull request
- 📖 **Documentation:** See [CONTRIBUTING.md](CONTRIBUTING.md)

---

**🌟 Star this repo if it helps you!**
