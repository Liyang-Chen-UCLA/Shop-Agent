from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any


Handler = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]


def run_tool(handler: Handler) -> None:
    try:
        request = json.load(sys.stdin)
        arguments = request.get("arguments", {})
        context = request.get("context", {})
        if not isinstance(arguments, dict):
            raise ValueError("arguments must be an object")
        if not isinstance(context, dict):
            raise ValueError("context must be an object")
        result = handler(arguments, context)
        response = {"ok": True, "result": result}
    except Exception as error:  # The TypeScript runner turns this envelope into a tool error.
        response = {
            "ok": False,
            "error": {"code": type(error).__name__.upper(), "message": str(error)},
        }
    json.dump(response, sys.stdout, ensure_ascii=False, separators=(",", ":"))

