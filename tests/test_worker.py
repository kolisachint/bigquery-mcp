"""Tests for the BigQuery MCP worker (contract handlers + serialization)."""

import datetime
import decimal
from unittest.mock import patch

import pytest

from bigquery_mcp.worker import _json_default
from bigquery_mcp.worker_ops import BigQueryWorker, WorkerError


@pytest.fixture
def worker(mock_bigquery_client, monkeypatch):
    """A BigQueryWorker wired to the mocked BigQuery client (no real creds)."""
    monkeypatch.delenv("BIGQUERY_ALLOWED_DATASETS", raising=False)
    monkeypatch.setenv("GCP_PROJECT_ID", "test-project")
    monkeypatch.setenv("BIGQUERY_LOCATION", "US")
    with patch("bigquery_mcp.worker_ops.bigquery.Client", return_value=mock_bigquery_client):
        return BigQueryWorker()


def test_json_default_serializes_bigquery_types():
    assert _json_default(datetime.date(2026, 6, 5)) == "2026-06-05"
    assert _json_default(decimal.Decimal("5")) == 5
    assert _json_default(decimal.Decimal("5.5")) == 5.5
    assert _json_default(b"abc") == "YWJj"  # base64 of "abc"
    assert _json_default({1, 2}) in ([1, 2], [2, 1])


def test_health_returns_worker_identity(worker):
    data, meta = worker.dispatch("health", {})
    assert data["worker"] == "python"
    assert data["project"] == "test-project"
    assert meta == {}


def test_run_query_rejects_unsafe_sql(worker):
    with pytest.raises(WorkerError) as exc:
        worker.dispatch("run_query", {"sql": "DROP TABLE users"})
    assert exc.value.code == "UnsafeQuery"


def test_run_query_returns_rows_and_meta(worker):
    data, meta = worker.dispatch("run_query", {"sql": "SELECT 1"})
    assert data == []
    assert meta["total_count"] == 0
    assert meta["bytes_processed"] == 1000


def test_dry_run_query_reports_estimated_bytes(worker):
    data, meta = worker.dispatch("dry_run_query", {"sql": "SELECT 1"})
    assert data["total_bytes_processed"] == 1000
    assert meta["total_bytes_processed"] == 1000


def test_list_datasets_basic(worker):
    data, meta = worker.dispatch("list_datasets", {})
    assert data == ["test_dataset"]
    assert meta["returned_count"] == 1


def test_dispatch_rejects_unknown_op(worker):
    with pytest.raises(WorkerError) as exc:
        worker.dispatch("nonsense", {})
    assert exc.value.code == "BadRequest"
