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

Input (the runtime injects `context`; it is not supplied by the model):

```json
{"callId":"...","tool":"search_products","arguments":{"query":"..."},"context":{"sessionId":"...","dataDirectory":"..."}}
```

Python always starts in UTF-8 mode. State tools require the trusted session context; taxonomy and other stateless tools may ignore it.

The market stage has two additional narrow tools. `load_base` reads only the
base artifact for the trusted active mapped route. `shopping_env` accepts only
`{}` and takes the next product in rank/item-id order. It has no input arguments
for rereading or selecting an item; the trusted validator reads selected
contexts internally.
The trusted context supplies `datasetPath`, `maxDistinctProducts`, and a
run id; the complete parquet `context_text` is returned as `ocr_text`.
Sampling state is persisted under `.shop-agent/shopping-env/`.

Success:

```json
{"ok":true,"result":{"items":[]}}
```

Failure:

```json
{"ok":false,"error":{"code":"SEARCH_FAILED","message":"..."}}
```
