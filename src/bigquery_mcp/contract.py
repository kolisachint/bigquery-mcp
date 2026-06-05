"""Access to the shared tool contract (contract/tools.json).

The contract is the single source of truth for the tool surface shared by this
Python server and the JS server (bigquery-mcp-js). Tool descriptions are read
from here so they cannot drift, and a conformance test (tests/test_contract.py)
checks the registered tools and sample outputs against it.

The file is shipped inside the installed package as ``bigquery_mcp/contract.json``
(via ``force-include`` in pyproject.toml). In a source checkout it is read from
the canonical ``contract/tools.json`` at the repository root.
"""

from __future__ import annotations

import json
from functools import cache, lru_cache
from pathlib import Path
from typing import Any


def _load_contract() -> dict[str, Any]:
    # Installed package: bigquery_mcp/contract.json sits next to this module.
    packaged = Path(__file__).with_name("contract.json")
    if packaged.is_file():
        with packaged.open(encoding="utf-8") as f:
            data: dict[str, Any] = json.load(f)
            return data

    # Source checkout: repo-root contract/tools.json (src/bigquery_mcp -> repo root).
    repo_root = Path(__file__).resolve().parents[2]
    canonical = repo_root / "contract" / "tools.json"
    with canonical.open(encoding="utf-8") as f:
        data = json.load(f)
        return data


@lru_cache(maxsize=1)
def _contract() -> dict[str, Any]:
    return _load_contract()


def contract_version() -> str:
    return str(_contract()["contractVersion"])


def tools() -> list[dict[str, Any]]:
    tool_list: list[dict[str, Any]] = list(_contract()["tools"])
    return tool_list


@cache
def get_tool(name: str) -> dict[str, Any]:
    for tool in _contract()["tools"]:
        if tool["name"] == name:
            found: dict[str, Any] = tool
            return found
    raise KeyError(name)


def description(name: str) -> str:
    """Return the contract `summary` used as the MCP tool description."""
    return str(get_tool(name)["summary"])


def input_schema(name: str) -> dict[str, Any]:
    return dict(get_tool(name)["input"])


def output_schema(name: str) -> dict[str, Any]:
    return dict(get_tool(name)["output"])
