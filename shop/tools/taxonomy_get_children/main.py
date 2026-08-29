from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from taxonomy_common import get_children
from tool_runtime import run_tool


def handle(arguments: dict[str, Any], _context: dict[str, Any]) -> dict[str, Any]:
    node_ids = arguments.get("node_ids")
    if not isinstance(node_ids, list) or not node_ids or not all(isinstance(item, str) and item.strip() for item in node_ids):
        raise ValueError("node_ids must be a non-empty array of strings")
    normalized = list(dict.fromkeys(item.strip() for item in node_ids))
    return {"results": get_children(normalized)}


run_tool(handle)
