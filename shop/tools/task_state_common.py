from __future__ import annotations

import os
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any, TypedDict

os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph


PreferenceScalar = str | int | float | bool
PreferenceValue = PreferenceScalar | list[PreferenceScalar]


class TaskState(TypedDict):
    schema_version: int
    active_task_id: str | None
    tasks: list[dict[str, Any]]


def empty_state() -> TaskState:
    return {"schema_version": 1, "active_task_id": None, "tasks": []}


def _validate_preference(preference: Any) -> dict[str, PreferenceValue]:
    if not isinstance(preference, dict):
        raise ValueError("preference must be an object")
    result: dict[str, PreferenceValue] = {}
    for raw_key, value in preference.items():
        if not isinstance(raw_key, str) or not raw_key.strip():
            raise ValueError("preference keys must be non-empty strings")
        key = raw_key.strip()
        if isinstance(value, (str, int, float, bool)) and not isinstance(value, complex):
            result[key] = value
            continue
        if isinstance(value, list) and value and all(isinstance(item, (str, int, float, bool)) for item in value):
            result[key] = list(value)
            continue
        raise ValueError(f"preference '{key}' must be a scalar or non-empty scalar array")
    return result


def _validate_route(route: Any) -> dict[str, str]:
    if not isinstance(route, dict):
        raise ValueError("route must be an object")
    required = ("node_id", "node_name", "node_path")
    if set(route) != set(required):
        raise ValueError("route must contain only node_id, node_name, and node_path")
    result = {key: route[key].strip() for key in required if isinstance(route.get(key), str)}
    if len(result) != len(required) or not all(result.values()):
        raise ValueError("route fields must be non-empty strings")
    return result


def validate_state(state: Any) -> TaskState:
    if not isinstance(state, dict):
        raise ValueError("task state must be an object")
    if state.get("schema_version") != 1:
        raise ValueError("unsupported task state schema version")
    active_task_id = state.get("active_task_id")
    if active_task_id is not None and not isinstance(active_task_id, str):
        raise ValueError("active_task_id must be a string or null")
    tasks = state.get("tasks")
    if not isinstance(tasks, list):
        raise ValueError("tasks must be an array")
    task_ids: set[str] = set()
    node_ids: set[str] = set()
    normalized_tasks: list[dict[str, Any]] = []
    for task in tasks:
        if not isinstance(task, dict) or set(task) != {"task_id", "product", "preference", "route"}:
            raise ValueError("each task must contain only task_id, product, preference, and route")
        task_id = task.get("task_id")
        product = task.get("product")
        if not isinstance(task_id, str) or not task_id.strip():
            raise ValueError("task_id must be a non-empty string")
        if not isinstance(product, str) or not product.strip():
            raise ValueError("product must be a non-empty string")
        if task_id in task_ids:
            raise ValueError(f"duplicate task id: {task_id}")
        route = _validate_route(task.get("route"))
        if route["node_id"] in node_ids:
            raise ValueError(f"duplicate taxonomy node task: {route['node_id']}")
        task_ids.add(task_id)
        node_ids.add(route["node_id"])
        normalized_tasks.append(
            {
                "task_id": task_id,
                "product": product.strip(),
                "preference": _validate_preference(task.get("preference")),
                "route": route,
            }
        )
    if active_task_id is not None and active_task_id not in task_ids:
        raise ValueError("active_task_id must reference an existing task")
    return {"schema_version": 1, "active_task_id": active_task_id, "tasks": normalized_tasks}


def _persist_node(state: TaskState) -> TaskState:
    return validate_state(state)


def _build_graph(checkpointer: SqliteSaver):
    builder = StateGraph(TaskState)
    builder.add_node("persist", _persist_node)
    builder.add_edge(START, "persist")
    builder.add_edge("persist", END)
    return builder.compile(checkpointer=checkpointer)


def _runtime(context: dict[str, Any]) -> tuple[str, Path]:
    session_id = context.get("sessionId")
    data_directory = context.get("dataDirectory")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("trusted session context is required")
    if not isinstance(data_directory, str) or not data_directory.strip():
        raise ValueError("trusted data directory context is required")
    base = Path(data_directory).resolve()
    checkpoint_directory = base / "checkpoints"
    checkpoint_directory.mkdir(parents=True, exist_ok=True)
    return session_id, checkpoint_directory / "task-state.sqlite3"


def load_state(context: dict[str, Any]) -> TaskState:
    session_id, database = _runtime(context)
    config = {"configurable": {"thread_id": session_id}}
    with SqliteSaver.from_conn_string(str(database)) as checkpointer:
        graph = _build_graph(checkpointer)
        snapshot = graph.get_state(config)
        if not snapshot.values:
            return empty_state()
        return validate_state(snapshot.values)


def save_state(context: dict[str, Any], state: TaskState) -> TaskState:
    session_id, database = _runtime(context)
    config = {"configurable": {"thread_id": session_id}}
    normalized = validate_state(state)
    with SqliteSaver.from_conn_string(str(database)) as checkpointer:
        graph = _build_graph(checkpointer)
        result = graph.invoke(normalized, config)
    return validate_state(result)


def upsert_task(arguments: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    product = arguments.get("product")
    if not isinstance(product, str) or not product.strip():
        raise ValueError("product must be a non-empty string")
    incoming_preference = _validate_preference(arguments.get("preference", {}))
    remove_keys = arguments.get("remove_preference_keys", [])
    if not isinstance(remove_keys, list) or not all(isinstance(item, str) and item.strip() for item in remove_keys):
        raise ValueError("remove_preference_keys must be an array of non-empty strings")
    route = _validate_route(arguments.get("route"))
    requested_task_id = arguments.get("task_id")
    if requested_task_id is not None and (not isinstance(requested_task_id, str) or not requested_task_id.strip()):
        raise ValueError("task_id must be a non-empty string when provided")

    state = deepcopy(load_state(context))
    tasks = state["tasks"]
    by_task_id = {task["task_id"]: task for task in tasks}
    by_node_id = {task["route"]["node_id"]: task for task in tasks}
    source = by_task_id.get(requested_task_id) if requested_task_id else None
    target = by_node_id.get(route["node_id"])
    action = "updated"

    if target is None and source is None:
        target = {
            "task_id": str(uuid.uuid4()),
            "product": product.strip(),
            "preference": {},
            "route": route,
        }
        tasks.append(target)
        action = "created"
    elif target is None:
        target = source
    elif source is not None and source is not target:
        merged = dict(target["preference"])
        merged.update(source["preference"])
        target["preference"] = merged
        tasks.remove(source)
        action = "merged"

    assert target is not None
    merged_preference = dict(target["preference"])
    merged_preference.update(incoming_preference)
    for key in remove_keys:
        merged_preference.pop(key.strip(), None)
    target.update(
        {
            "product": product.strip(),
            "preference": merged_preference,
            "route": route,
        }
    )
    state["active_task_id"] = target["task_id"]
    saved = save_state(context, state)
    return {"action": action, "task": deepcopy(target), "state": saved}


def set_active_task(arguments: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    task_id = arguments.get("task_id")
    if not isinstance(task_id, str) or not task_id.strip():
        raise ValueError("task_id must be a non-empty string")
    state = deepcopy(load_state(context))
    if not any(task["task_id"] == task_id for task in state["tasks"]):
        raise ValueError(f"unknown task id: {task_id}")
    state["active_task_id"] = task_id
    return {"state": save_state(context, state)}


def delete_task(arguments: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    task_id = arguments.get("task_id")
    if not isinstance(task_id, str) or not task_id.strip():
        raise ValueError("task_id must be a non-empty string")
    state = deepcopy(load_state(context))
    remaining = [task for task in state["tasks"] if task["task_id"] != task_id]
    if len(remaining) == len(state["tasks"]):
        raise ValueError(f"unknown task id: {task_id}")
    state["tasks"] = remaining
    if state["active_task_id"] == task_id:
        state["active_task_id"] = remaining[-1]["task_id"] if remaining else None
    return {"state": save_state(context, state)}
