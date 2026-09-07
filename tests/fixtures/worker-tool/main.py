from __future__ import annotations

import os
import time
from typing import Any


def handle(arguments: dict[str, Any], _context: dict[str, Any]) -> dict[str, Any]:
    action = arguments.get("action", "pid")
    if action == "sleep":
        time.sleep(float(arguments.get("seconds", 0)))
    elif action == "crash":
        os._exit(23)
    elif action == "print":
        print("ordinary tool output")
    elif action == "error":
        raise ValueError("ordinary tool failure")
    return {
        "pid": os.getpid(),
        "action": action,
        "allowed": os.environ.get("WORKER_ALLOWED_TEST"),
        "hasOpenCodeKey": "OPENCODE_API_KEY" in os.environ,
    }
