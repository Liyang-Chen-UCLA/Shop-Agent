# Persistent Python worker

## Current design

Each Python tool call starts an isolated Python process, exchanges one request and response over stdin/stdout, and exits.

## Target design

Replace the one-shot runner with a project-level persistent worker using a framed JSON Lines or RPC protocol. Preserve the existing tool manifests, request envelope, response envelope, timeouts, cancellation, schema validation, and environment allowlists.

## Why deferred

One-shot execution is simpler to debug and prevents state leakage while the business tool set is still evolving.

## Migration trigger

Repeated Python startup becomes a measurable share of tool latency, or a tool needs cached models, sessions, or connection pools.

## Acceptance criteria

- Worker restart after crashes is automatic.
- Requests have independent cancellation and timeouts.
- A failed request cannot corrupt later responses.
- No additional environment variables become visible to Python.
- Existing one-shot tools continue to work without manifest changes.
