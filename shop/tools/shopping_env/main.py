from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shopping_env_common import shopping_env
from tool_runtime import run_tool


def handle(arguments: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    return shopping_env(arguments, context)


run_tool(handle)
