from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from task_state_common import upsert_task
from tool_runtime import run_tool


run_tool(upsert_task)
