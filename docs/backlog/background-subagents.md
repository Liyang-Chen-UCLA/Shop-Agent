# Background and concurrent subagents

## Current design

The orchestrator runs one foreground subagent at a time. Subagents receive a fresh context and cannot delegate further.

## Target design

Add bounded parallel and background runs, persistent status inspection, steering and stopping, plus a compact FleetView-style TUI inspector.

## Why deferred

Serial foreground delegation is easier to reason about and matches the first Shop Agent orchestration requirement.

## Migration trigger

A workflow needs independent product-source searches or long-running work that should not block the main conversation.

## Acceptance criteria

- Explicit concurrency and cumulative spawn limits.
- Owner-session isolation for run artifacts.
- Stable run IDs and machine-readable events.
- Graceful stop followed by process-tree termination when necessary.
- Main transcript contains summaries rather than complete child output.
