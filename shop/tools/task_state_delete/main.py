from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from task_state_common import delete_task
from tool_runtime import run_tool


run_tool(delete_task)
