import json
import os
import sys


request = json.load(sys.stdin)
print(json.dumps({
    "ok": True,
    "result": {
        "value": request["arguments"]["value"],
        "hasOpenCodeKey": "OPENCODE_API_KEY" in os.environ,
    },
}))
