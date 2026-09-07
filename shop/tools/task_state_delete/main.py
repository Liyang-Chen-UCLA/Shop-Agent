from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from task_state_common import delete_task
from tool_runtime import run_tool


def handle(arguments: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    return delete_task(arguments, context)


if __name__ == "__main__":
    run_tool(handle)
