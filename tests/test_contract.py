"""Conformance tests: the Python server must match the shared contract.

These assert that the tools the server registers (names, descriptions, and input
parameters) match contract/tools.json, and that representative tool outputs
validate against each tool's `output` JSON Schema. Together with the JS contract
test (which checks the same contract), this keeps the two servers from drifting.
"""

import inspect
import types
import typing
from unittest.mock import Mock

import jsonschema
import pytest

from bigquery_mcp import contract
from bigquery_mcp.bigquery_tools import clear_embedding_tables_cache, register_tools


def _capture_tools(mock_client, *, location="US"):
    """Register tools against a fake mcp, capturing handler + description."""
    captured: dict[str, dict] = {}

    def mock_tool(fn=None, *, description=None):
        def decorator(func):
            captured[func.__name__] = {"func": func, "description": description}
            return func

        return decorator(fn) if fn else decorator

    mcp = Mock()
    mcp.tool = mock_tool
    register_tools(mcp, mock_client, allowed_datasets=None, location=location)
    return captured


def _simple_type(tp) -> str:
    if tp is bool:
        return "boolean"
    if tp is int:
        return "integer"
    if tp is str:
        return "string"
    return "string"


def _contract_type(annotation) -> object:
    """Map a Python parameter annotation to the contract's JSON-Schema type."""
    origin = typing.get_origin(annotation)
    if origin is typing.Union or origin is types.UnionType:
        args = list(typing.get_args(annotation))
        has_none = any(a is type(None) for a in args)
        non_none = [a for a in args if a is not type(None)]
        base = _simple_type(non_none[0])
        return [base, "null"] if has_none else base
    return _simple_type(annotation)


def _normalize_type(t) -> object:
    return sorted(t) if isinstance(t, list) else t


def test_contract_is_valid_against_meta_schema():
    """The contract file itself conforms to contract.schema.json."""
    import json
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[1]
    meta = json.loads((repo_root / "contract" / "contract.schema.json").read_text())
    jsonschema.validate(instance=contract._contract(), schema=meta)


def test_registered_tools_match_contract(env_vars):
    _ = env_vars
    captured = _capture_tools(Mock())
    contract_names = {t["name"] for t in contract.tools()}
    assert set(captured.keys()) == contract_names


def test_tool_descriptions_match_contract(env_vars):
    _ = env_vars
    captured = _capture_tools(Mock())
    for name, info in captured.items():
        assert info["description"] == contract.description(name), f"description drift for {name}"


def test_input_parameters_match_contract(env_vars):
    _ = env_vars
    captured = _capture_tools(Mock())
    for name, info in captured.items():
        spec = contract.input_schema(name)
        props = spec.get("properties", {})
        required = set(spec.get("required", []))

        hints = typing.get_type_hints(info["func"], include_extras=True)
        sig = inspect.signature(info["func"])

        # Same parameter set.
        assert set(sig.parameters.keys()) == set(props.keys()), f"param set drift for {name}"

        for pname, param in sig.parameters.items():
            annotated = hints[pname]
            base_type, field_info = typing.get_args(annotated)
            prop = props[pname]

            # Type matches the contract.
            assert _normalize_type(_contract_type(base_type)) == _normalize_type(prop["type"]), (
                f"type drift for {name}.{pname}"
            )

            # Required-ness matches (no default => required).
            is_required = param.default is inspect.Parameter.empty
            assert is_required == (pname in required), f"required drift for {name}.{pname}"

            # Parameter description matches the contract.
            assert field_info.description == prop.get("description"), f"description drift for {name}.{pname}"


# ---- output schema validation ------------------------------------------------


@pytest.mark.asyncio
async def test_outputs_validate_against_contract(env_vars, mock_bigquery_client):
    _ = env_vars
    # Make get_table produce a clean, JSON-serializable type field.
    mock_bigquery_client.get_table.return_value.table_type = "TABLE"

    captured = _capture_tools(mock_bigquery_client)

    async def check(name, **kwargs):
        result = await captured[name]["func"](**kwargs)
        assert result["success"] is True, f"{name} did not succeed: {result}"
        jsonschema.validate(instance=result, schema=contract.output_schema(name))

    await check("run_query", query="SELECT 1")
    await check("dry_run_query", query="SELECT 1")
    await check("list_datasets_in_project")
    await check("get_table", dataset_id="test_dataset1", table_id="t")

    # vector_search discovery populates a module-level cache; clear it around the
    # call so we don't leak state into other tests (and vice versa).
    clear_embedding_tables_cache()
    try:
        await check("vector_search")  # discovery mode (empty query_text)
    finally:
        clear_embedding_tables_cache()
