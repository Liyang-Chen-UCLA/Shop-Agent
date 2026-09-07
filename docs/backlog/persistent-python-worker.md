# Persistent Python worker

## Status

Completed. Shop Agent now owns one project-level `.venv` Python worker.

## Implemented design

The worker uses JSONL RPC and a fixed tool/validator registry. The orchestrator calls it through `PythonExecutor`; child runners use `ChildPythonProxy`, with parent-side permission checks before forwarding. Requests are serial, per-call environments are restored, stdout is protocol-only, and crashes or running cancellation trigger one restart without replay.

## Setup boundary

`uv sync --locked` creates and maintains `.venv`. Runtime resolves only `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` elsewhere and never invokes uv or a system Python fallback.

## Lifecycle

`ShopAgent.create()` starts and initializes the worker before building agents. `ShopAgent.close()` aborts the agent, closes child runners, cancels Python requests, requests worker shutdown, and force-kills it if necessary.

## Acceptance criteria

- Worker restart after crashes is automatic.
- Requests have independent cancellation and timeouts.
- A failed request cannot corrupt later responses.
- No additional environment variables become visible to Python.
- Existing tool manifests continue to work without schema changes; modules expose `handle(arguments, context)` and retain CLI debugging entry points.
