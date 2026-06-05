#!/usr/bin/env python3
"""Python worker for the BigQuery MCP worker contract.

Speaks newline-delimited JSON over stdio: one request object per line in, one
response object per line out, correlated by ``id``. This is the preferred
worker spawned by the Node MCP control plane's broker; it reuses the existing
``bigquery_tools`` logic so behaviour matches the in-process FastMCP server.

Wire protocol:
    request:  {"id": "...", "op": "run_query", "params": {...}}
    response: {"id": "...", "ok": true, "data": ..., "meta": {...}}
              {"id": "...", "ok": false, "error": "...", "code": "..."}

stdout is reserved exclusively for response lines; all logging goes to stderr.
"""

from __future__ import annotations

import base64
import datetime
import decimal
import json
import os
import sys
from typing import Any

from dotenv import load_dotenv


def _json_default(obj: Any) -> Any:
    """JSON-encode BigQuery value types that aren't natively serializable."""
    if isinstance(obj, datetime.datetime | datetime.date | datetime.time):
        return obj.isoformat()
    if isinstance(obj, decimal.Decimal):
        # Preserve integers as int, otherwise fall back to float.
        return int(obj) if obj == obj.to_integral_value() else float(obj)
    if isinstance(obj, bytes):
        return base64.b64encode(obj).decode("ascii")
    if isinstance(obj, set | frozenset):
        return list(obj)
    if isinstance(obj, datetime.timedelta):
        return obj.total_seconds()
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    return str(obj)


def _write(response: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(response, default=_json_default) + "\n")
    sys.stdout.flush()


def main() -> None:
    load_dotenv()

    # Import after env is loaded so module-level config picks up the right values.
    try:
        from .worker_ops import BigQueryWorker, WorkerError
    except ImportError:  # pragma: no cover - direct execution fallback
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from bigquery_mcp.worker_ops import BigQueryWorker, WorkerError

    try:
        worker = BigQueryWorker()
    except Exception as e:
        # Cannot construct the client (e.g. missing credentials/project). Emit a
        # single error so the broker's health check fails cleanly and it can
        # fall back to the Node worker.
        print(f"[python-worker] failed to initialize: {e}", file=sys.stderr)
        sys.exit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            print(f"[python-worker] non-JSON request: {line}", file=sys.stderr)
            continue

        request_id = request.get("id", "")
        op = request.get("op")
        params = request.get("params") or {}

        if not op:
            _write({"id": request_id, "ok": False, "error": "Missing 'op' in request", "code": "BadRequest"})
            continue

        try:
            data, meta = worker.dispatch(op, params)
            _write({"id": request_id, "ok": True, "data": data, "meta": meta})
        except WorkerError as e:
            _write({"id": request_id, "ok": False, "error": str(e), "code": e.code})
        except Exception as e:
            _write({"id": request_id, "ok": False, "error": str(e), "code": type(e).__name__})


if __name__ == "__main__":
    main()
