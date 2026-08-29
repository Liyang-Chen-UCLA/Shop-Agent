# Python tools

Shop Agent discovers manifests at `shop/tools/**/tool.json`. Discovery registers a tool; an agent can use it only when the tool name is present in that profile's `tools` allowlist.

Each directory contains a manifest and Python entry point:

```text
shop/tools/
  search_products/
    tool.json
    main.py
```

Example manifest:

```json
{
  "name": "search_products",
  "description": "Search the configured product source.",
  "entry": "main.py",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" }
    },
    "required": ["query"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "items": { "type": "array", "items": { "type": "object" } }
    },
    "required": ["items"]
  },
  "timeoutMs": 60000,
  "env": ["PRODUCT_API_KEY"]
}
```

The runner starts `D:\App\miniforge3\envs\shop-agent\python.exe`, sends one JSON object to stdin, and expects exactly one JSON object on stdout. Write logs to stderr.

Input:

```json
{"callId":"...","tool":"search_products","arguments":{"query":"..."}}
```

Success:

```json
{"ok":true,"result":{"items":[]}}
```

Failure:

```json
{"ok":false,"error":{"code":"SEARCH_FAILED","message":"..."}}
```
