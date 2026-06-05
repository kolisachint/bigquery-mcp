"""Worker op implementations for the BigQuery MCP worker contract.

These functions implement the language-neutral worker contract used by the Node
MCP control plane. They deliberately reuse the existing helpers in
``bigquery_tools`` so the Python worker and the in-process FastMCP server behave
identically. Each handler returns a ``(data, meta)`` tuple; the worker wraps it
into the wire response.
"""

from __future__ import annotations

import os
from typing import Any

from google.cloud import bigquery

from . import bigquery_tools as bt
from .query_safety import is_query_safe

OpResult = tuple[Any, dict[str, Any]]


class WorkerError(Exception):
    """Raised for expected, user-facing worker failures (carries a code)."""

    def __init__(self, message: str, code: str = "WorkerError") -> None:
        super().__init__(message)
        self.code = code


class BigQueryWorker:
    """Executes worker-contract ops against BigQuery, reusing bigquery_tools."""

    def __init__(self) -> None:
        self.project_id = os.getenv("GCP_PROJECT_ID")
        self.location = os.getenv("BIGQUERY_LOCATION")
        self.client = bigquery.Client(project=self.project_id)

        env_datasets = os.getenv("BIGQUERY_ALLOWED_DATASETS")
        self.allowed_datasets: list[str] | None = (
            [d.strip() for d in env_datasets.split(",") if d.strip()] if env_datasets else None
        )

    # ---- helpers ---------------------------------------------------------

    def _dataset_allowed(self, dataset_id: str) -> bool:
        return not self.allowed_datasets or dataset_id in self.allowed_datasets

    # ---- ops -------------------------------------------------------------

    def health(self, _params: dict[str, Any]) -> OpResult:
        # Minimal access check: list a single dataset.
        list(self.client.list_datasets(max_results=1))
        return {"worker": "python", "project": self.project_id, "location": self.location}, {}

    def list_datasets(self, params: dict[str, Any]) -> OpResult:
        search = params.get("search") or ""
        detailed = bool(params.get("detailed", False))
        max_results = params.get("max_results")
        if max_results is None:
            max_results = bt.get_list_max_results(detailed)

        fetch_limit = bt._calculate_search_fetch_limit(max_results, search)
        datasets_list = list(self.client.list_datasets(max_results=fetch_limit))
        total_available = len(datasets_list)

        if self.allowed_datasets:
            datasets_list = [d for d in datasets_list if d.dataset_id in self.allowed_datasets]
        if search:
            datasets_list = bt._filter_by_search_term(datasets_list, search, lambda d: d.dataset_id)

        total_matching = len(datasets_list)
        datasets_list = datasets_list[:max_results]
        returned_count = len(datasets_list)

        if detailed:
            detailed_list: list[dict[str, Any]] = []
            for dataset in datasets_list:
                table_count = 0
                try:
                    dataset_ref = self.client.dataset(dataset.dataset_id)
                    table_count = len(list(self.client.list_tables(dataset_ref, max_results=1000)))
                except Exception as e:
                    print(f"Warning: Failed to get table count for dataset {dataset.dataset_id}: {e}")
                detailed_list.append({
                    "dataset_id": dataset.dataset_id,
                    "description": getattr(dataset, "description", None),
                    "table_count": table_count,
                })
            detailed_list.sort(key=lambda x: x["dataset_id"])
            data: Any = detailed_list
        else:
            data = sorted(d.dataset_id for d in datasets_list)

        meta = {
            "total_available": total_available,
            "total_matching": total_matching if search else total_available,
            "returned_count": returned_count,
        }
        return data, meta

    def list_tables(self, params: dict[str, Any]) -> OpResult:
        dataset_id = params["dataset_id"]
        if not self._dataset_allowed(dataset_id):
            raise WorkerError(f"Access to dataset '{dataset_id}' is not allowed", "AccessDenied")

        search = params.get("search") or ""
        detailed = bool(params.get("detailed", False))
        max_results = params.get("max_results")
        if max_results is None:
            max_results = bt.get_list_max_results(detailed)

        dataset_ref = self.client.dataset(dataset_id)
        dataset_obj = self.client.get_dataset(dataset_ref)

        fetch_limit = bt._calculate_search_fetch_limit(max_results, search)
        tables_list = list(self.client.list_tables(dataset_ref, max_results=fetch_limit))
        total_available = len(tables_list)

        if search:
            tables_list = bt._filter_by_search_term(tables_list, search, lambda t: t.table_id)
        total_matching = len(tables_list)
        tables_list = tables_list[:max_results]
        returned_count = len(tables_list)

        dataset_context = {
            "dataset_id": dataset_id,
            "description": dataset_obj.description,
            "location": dataset_obj.location,
            "total_table_count": total_available,
        }

        if detailed:
            detailed_list: list[dict[str, Any]] = []
            for table in tables_list:
                table_obj = self.client.get_table(dataset_ref.table(table.table_id))
                detailed_list.append({
                    "table_id": table.table_id,
                    "type": bt._get_table_type_with_partitioning(table),
                    "description": table_obj.description,
                    "row_count": table_obj.num_rows,
                    "size_bytes": table_obj.num_bytes,
                })
            detailed_list.sort(key=lambda x: x["table_id"])
            data: Any = detailed_list
        else:
            data = sorted(t.table_id for t in tables_list)

        meta = {
            "total_available": total_available,
            "total_matching": total_matching if search else total_available,
            "returned_count": returned_count,
            "dataset_context": dataset_context,
        }
        return data, meta

    def get_table(self, params: dict[str, Any]) -> OpResult:
        dataset_id = params["dataset_id"]
        table_id = params["table_id"]
        if not self._dataset_allowed(dataset_id):
            raise WorkerError(f"Access to dataset '{dataset_id}' is not allowed", "AccessDenied")

        dataset_ref = self.client.dataset(dataset_id)
        table_ref = dataset_ref.table(table_id)
        table_obj = self.client.get_table(table_ref)
        table_path = f"{dataset_id}.{table_id}"

        partition_details = bt._extract_partition_details(table_obj)
        primary_key_columns = bt._get_primary_key_columns(table_obj)

        sample_size = bt.get_table_stats_sample_size()
        column_fill_rates = bt._calculate_column_fill_rates(self.client, table_path, table_obj.schema, sample_size)

        sample_rows_count = bt.get_table_sample_data_rows()
        sample_data: list[dict[str, Any]] = []
        try:
            timestamp_columns = [
                field.name for field in table_obj.schema if field.field_type in ["TIMESTAMP", "DATETIME", "DATE"]
            ]
            order_clause = f"ORDER BY `{timestamp_columns[0]}` DESC" if timestamp_columns else ""
            sample_query = f"SELECT * FROM `{table_path}` {order_clause} LIMIT {sample_rows_count}"  # noqa: S608
            query_job = self.client.query(sample_query, job_config=bt._create_query_job_config())
            sample_data = [dict(row) for row in query_job.result()]
        except Exception:
            sample_data = []

        schema_with_stats = [
            {
                "name": field.name,
                "type": field.field_type,
                "mode": field.mode,
                "description": field.description,
                "fill_rate_percent": column_fill_rates.get(field.name, 0.0),
            }
            for field in table_obj.schema
        ]

        data = {
            "table_path": table_path,
            "type": bt._get_table_type_with_partitioning(table_obj, partition_details),
            "description": table_obj.description,
            "total_row_count": table_obj.num_rows,
            "size_bytes": table_obj.num_bytes,
            "created": table_obj.created.isoformat() if table_obj.created else None,
            "modified": table_obj.modified.isoformat() if table_obj.modified else None,
            "partition_details": partition_details,
            "primary_key_columns": primary_key_columns,
            "schema_with_fill_rates": schema_with_stats,
            "fill_rate_sample_size": sample_size if column_fill_rates else 0,
            "sample_data": sample_data,
        }
        return data, {}

    def dry_run_query(self, params: dict[str, Any]) -> OpResult:
        sql = params["sql"]
        is_safe, error_msg = is_query_safe(sql)
        if not is_safe:
            raise WorkerError(error_msg, "UnsafeQuery")
        job_config = bt._create_query_job_config(dry_run=True, use_query_cache=False)
        query_job = self.client.query(sql, job_config=job_config)
        bytes_processed = query_job.total_bytes_processed
        meta = {
            "total_bytes_processed": bytes_processed,
            "max_bytes_billed": bt.get_query_max_bytes_billed(),
        }
        return {"total_bytes_processed": bytes_processed}, meta

    def run_query(self, params: dict[str, Any]) -> OpResult:
        sql = params["sql"]
        is_safe, error_msg = is_query_safe(sql)
        if not is_safe:
            raise WorkerError(error_msg, "UnsafeQuery")
        query_job = self.client.query(sql, job_config=bt._create_query_job_config())
        results = query_job.result()
        rows = [dict(row) for row in results]
        meta = {
            "total_count": len(rows),
            "total_rows_in_result": getattr(results, "total_rows", len(rows)),
            "bytes_processed": query_job.total_bytes_processed,
            "max_bytes_billed": bt.get_query_max_bytes_billed(),
        }
        return rows, meta

    # ---- vector search ---------------------------------------------------

    def vector_search(self, params: dict[str, Any]) -> OpResult:
        query_text = (params.get("query_text") or "").strip()
        if not query_text:
            return self._discover_embedding_tables()

        table_path = (params.get("table_path") or "").strip()
        if not table_path:
            raise WorkerError(
                "table_path is required for search. Leave query_text empty to discover tables.",
                "ValidationError",
            )
        model = bt.get_default_embedding_model()
        if not model:
            raise WorkerError(
                "BIGQUERY_EMBEDDING_MODEL environment variable is required for vector search.",
                "ConfigError",
            )
        top_k = int(params.get("top_k") or 10)
        if top_k < 1 or top_k > 1000:
            raise WorkerError("top_k must be between 1 and 1000", "ValidationError")

        distance_type = os.getenv("BIGQUERY_DISTANCE_TYPE", "COSINE").upper()
        if distance_type not in ("COSINE", "EUCLIDEAN", "DOT_PRODUCT"):
            raise WorkerError(f"Invalid BIGQUERY_DISTANCE_TYPE '{distance_type}'", "ConfigError")

        embedding_column = (params.get("embedding_column") or "embedding").strip() or "embedding"
        select_raw = (params.get("select_columns") or "").strip()
        select_columns = [c.strip() for c in select_raw.split(",") if c.strip()] if select_raw else None
        select_clause = ", ".join(f"base.`{col}`" for col in select_columns) if select_columns else "base.*"

        query = f"""
        WITH query_embedding AS (
            SELECT ml_generate_embedding_result AS embedding
            FROM ML.GENERATE_EMBEDDING(
                MODEL `{model}`,
                (SELECT @query_text AS content),
                STRUCT(TRUE AS flatten_json_output)
            )
        )
        SELECT
            {select_clause},
            ROUND((1 - distance) * 100, 2) AS similarity_pct,
            distance
        FROM VECTOR_SEARCH(
            TABLE `{table_path}`,
            '{embedding_column}',
            (SELECT embedding FROM query_embedding),
            top_k => {top_k},
            distance_type => '{distance_type}'
        )
        ORDER BY distance
        """  # noqa: S608

        job_config = bt._create_query_job_config(
            query_parameters=[bigquery.ScalarQueryParameter("query_text", "STRING", query_text)]
        )
        query_job = self.client.query(query, job_config=job_config)
        rows = [dict(row) for row in query_job.result()]
        reusable_query = query.replace("@query_text", f"'{query_text}'").strip()

        meta = {
            "total_count": len(rows),
            "mode": "search",
            "query_text": query_text,
            "table_path": table_path,
            "embedding_model": model,
            "distance_type": distance_type,
            "bytes_processed": query_job.total_bytes_processed,
            "max_bytes_billed": bt.get_query_max_bytes_billed(),
            "sql_query": reusable_query,
        }
        return rows, meta

    def _discover_embedding_tables(self) -> OpResult:
        pattern = bt.get_embedding_column_contains()

        # Strategy 1: explicitly configured tables.
        configured = bt.get_embedding_tables()
        if configured:
            tables = []
            for table_path in configured:
                parts = table_path.split(".")
                if len(parts) == 2:
                    tables.append({
                        "dataset_id": parts[0],
                        "table_id": parts[1],
                        "full_path": table_path,
                        "embedding_column_contains": pattern,
                    })
            return tables, {"total_count": len(tables), "mode": "discovery", "source": "BIGQUERY_EMBEDDING_TABLES"}

        # Strategy 2: region-level INFORMATION_SCHEMA scan.
        region = self.location or "US"
        query = f"""
        SELECT table_schema as dataset_id, table_name as table_id, column_name
        FROM `{self.project_id}.region-{region}`.INFORMATION_SCHEMA.COLUMNS
        WHERE data_type = 'ARRAY<FLOAT64>'
        """  # noqa: S608
        if pattern:
            query += f" AND LOWER(column_name) LIKE '%{pattern.lower()}%'"
        if self.allowed_datasets:
            datasets_str = "', '".join(self.allowed_datasets)
            query += f" AND table_schema IN ('{datasets_str}')"
        query += " ORDER BY table_schema, table_name, column_name"

        try:
            query_job = self.client.query(query, job_config=bt._create_query_job_config())
            tables_dict: dict[str, dict[str, Any]] = {}
            for row in query_job.result():
                key = f"{row.dataset_id}.{row.table_id}"
                if key not in tables_dict:
                    tables_dict[key] = {
                        "dataset_id": row.dataset_id,
                        "table_id": row.table_id,
                        "full_path": key,
                        "embedding_columns": [],
                    }
                tables_dict[key]["embedding_columns"].append(row.column_name)
            tables = list(tables_dict.values())
            return tables, {
                "total_count": len(tables),
                "mode": "discovery",
                "column_pattern": pattern,
                "source": "INFORMATION_SCHEMA",
            }
        except Exception as e:
            error_str = str(e)
            if "Access Denied" in error_str or "403" in error_str:
                raise WorkerError(
                    "Discovery requires 'BigQuery Metadata Viewer' role on the project, "
                    "or set BIGQUERY_EMBEDDING_TABLES env var to skip discovery. "
                    "Example: BIGQUERY_EMBEDDING_TABLES=dataset.table1,dataset.table2",
                    "AccessDenied",
                ) from e
            raise

    # ---- dispatch --------------------------------------------------------

    def dispatch(self, op: str, params: dict[str, Any]) -> OpResult:
        handlers = {
            "health": self.health,
            "list_datasets": self.list_datasets,
            "list_tables": self.list_tables,
            "get_table": self.get_table,
            "dry_run_query": self.dry_run_query,
            "run_query": self.run_query,
            "vector_search": self.vector_search,
        }
        handler = handlers.get(op)
        if handler is None:
            raise WorkerError(f"Unknown op: {op}", "BadRequest")
        return handler(params)
