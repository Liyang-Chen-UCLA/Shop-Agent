from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from market_mapping import dataset_category_for_node
from task_state_common import load_state
from tool_runtime import run_tool


def handle(_arguments: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    state = load_state(context)
    active_id = state.get("active_task_id")
    if not isinstance(active_id, str) or not active_id:
        raise ValueError("an active task is required for load_base")
    task = next((item for item in state["tasks"] if item.get("task_id") == active_id), None)
    if not isinstance(task, dict) or not isinstance(task.get("route"), dict):
        raise ValueError("active task route is unavailable")
    route = task["route"]
    node_id = route.get("node_id")
    if not isinstance(node_id, str) or not node_id:
        raise ValueError("active route node_id is invalid")
    # Resolve the mapping as a narrow capability check.  The tool itself does
    # not expose the category to model-authored arguments.
    dataset_category_for_node(node_id)
    artifact = Path(context["dataDirectory"]).resolve() / "market-criteria" / node_id / "base.json"
    if not artifact.is_file():
        raise ValueError(f"base criteria artifact is not available for taxonomy node {node_id}")
    try:
        value = json.loads(artifact.read_text(encoding="utf-8"))
    except Exception as error:
        raise ValueError(f"base criteria artifact cannot be read: {error}") from error
    if not isinstance(value, dict) or set(value) != {"node", "criteria", "attributes"}:
        raise ValueError("base criteria artifact has an invalid shape")
    return value


run_tool(handle)
