# Resumable task execution

## Current design

LangGraph checkpoints persist only canonical product-analysis task state. Tasks intentionally contain no execution lifecycle status or graph-control state. A restored transcript is sufficient to reconstruct confirmations that happen between completed conversation turns, but it cannot identify or resume work interrupted during a tool or agent call.

## Target design

Add durable graph-control state and an explicit task execution lifecycle:

```text
pending | running | completed | failed
```

Persist the current graph step, pending confirmation, invocation identity, and enough validated input to resume or safely retry an interrupted operation without duplicating completed work. Keep these operational fields separate from product, preference, and taxonomy route data.

## Why deferred

The current foreground, single-request tool protocol has no LangGraph interrupt/resume or streaming checkpoint contract. Canonical shopping state and taxonomy routing can be delivered without first replacing that protocol.

## Migration trigger

Users need reliable recovery from process termination during routing or delegated analysis, background task execution is introduced, or retries can cause duplicate external actions.

## Acceptance criteria

- Every executing task transitions through validated `pending`, `running`, `completed`, or `failed` states.
- Restarting the application can distinguish an unanswered conversational confirmation from an interrupted operation.
- Interrupted read-only work can resume or retry without losing canonical task state.
- Potentially mutating work uses an invocation identity so completed actions are not duplicated.
- Operational state remains separate from the minimal product-analysis task schema.
- Old checkpoints without execution fields migrate safely.
