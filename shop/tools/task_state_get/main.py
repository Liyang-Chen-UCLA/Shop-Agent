from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from task_state_common import load_state
from tool_runtime import run_tool


def handle(_arguments: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    return {"state": load_state(context)}


run_tool(handle)
