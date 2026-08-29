from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from taxonomy_common import search_nodes
from tool_runtime import run_tool


def handle(arguments: dict[str, Any], _context: dict[str, Any]) -> dict[str, Any]:
    queries = arguments.get("queries")
    if not isinstance(queries, list) or not queries or not all(isinstance(item, str) and item.strip() for item in queries):
        raise ValueError("queries must be a non-empty array of strings")
    limit = arguments.get("limit", 5)
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise ValueError("limit must be an integer")
    return {"results": search_nodes([item.strip() for item in queries], max(1, min(limit, 10)))}


run_tool(handle)
