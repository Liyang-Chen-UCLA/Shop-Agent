import json
import os
import sys
from typing import Any


def handle(arguments: dict[str, Any], _context: dict[str, Any]) -> dict[str, Any]:
    return {
        "value": arguments["value"],
        "hasOpenCodeKey": "OPENCODE_API_KEY" in os.environ,
    }


if __name__ == "__main__":
    request = json.load(sys.stdin)
    print(json.dumps({"ok": True, "result": handle(request["arguments"], request.get("context", {}))}))
