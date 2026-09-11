# Resumable task execution (delivered)

The foreground Subagent Resume MVP is implemented. Operational state remains separate from the canonical product-analysis task schema.

The orchestrator API is limited to:

```text
delegate(agent, task)
resume(taskId)
cancel(taskId)
```

A logical task uses `running | completed | interrupted | cancelled`. Each resume keeps the same `taskId`, creates a new execution, restores the last fully committed child turn, and re-executes work after that checkpoint. There is no automatic retry, inspect, steer, heartbeat, background execution, or parallel dispatch.

Langfuse represents each actual Subagent execution as an `agent` observation and records stable `taskId`, Subagent type, execution identity/number, lifecycle outcome, interruption reason, resume/cancel, and final output. The session ID groups executions with their owning Shop Agent conversation.

Mutation deduplication remains deferred. The MVP can repeat a side-effecting tool call that was not part of the last fully committed checkpoint.
