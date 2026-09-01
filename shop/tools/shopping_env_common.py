"""Deterministic, narrow access to the configured Taobao product context.

This module is intentionally the only code that reads the parquet source for
the market agent.  The route and sampling cursor are trusted runtime inputs;
the model can request only the next item or a reread of an item it already
selected in this run.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any
import re

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pyarrow.parquet as parquet

from market_mapping import MARKET_MAPPING_VERSION, NODE_TO_DATASET_CATEGORY, dataset_category_for_node
from task_state_common import load_state


DEFAULT_DATASET_PATH = Path(r"F:\Code\taobao-product-context\data\products.parquet")
DEFAULT_MAX_DISTINCT_PRODUCTS = 5


def _required_text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value.strip()


def _run_id(context: dict[str, Any]) -> str:
    # runId is supplied by the trusted child request.  The session fallback
    # keeps the tool useful in direct integration tests while remaining scoped
    # to one trusted session.
    return _required_text(context.get("runId") or context.get("sessionId"), "trusted run context")


def _data_directory(context: dict[str, Any]) -> Path:
    return Path(_required_text(context.get("dataDirectory"), "trusted data directory")).resolve()


def _dataset_path(context: dict[str, Any]) -> Path:
    raw = context.get("datasetPath")
    return Path(raw).expanduser().resolve() if isinstance(raw, str) and raw.strip() else DEFAULT_DATASET_PATH


def max_distinct_products(context: dict[str, Any]) -> int:
    value = context.get("maxDistinctProducts", DEFAULT_MAX_DISTINCT_PRODUCTS)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("maxDistinctProducts must be a positive integer")
    return value


def active_market_route(context: dict[str, Any]) -> tuple[dict[str, Any], str]:
    state = load_state(context)
    active_id = state.get("active_task_id")
    if not isinstance(active_id, str) or not active_id:
        raise ValueError("an active task is required for shopping_env")
    task = next((item for item in state["tasks"] if item.get("task_id") == active_id), None)
    if not isinstance(task, dict) or not isinstance(task.get("route"), dict):
        raise ValueError("active task route is unavailable")
    route = task["route"]
    node_id = _required_text(route.get("node_id"), "active route node_id")
    category = dataset_category_for_node(node_id)
    return route, category


def _cursor_path(context: dict[str, Any]) -> Path:
    run_hash = hashlib.sha256(_run_id(context).encode("utf-8")).hexdigest()
    directory = _data_directory(context) / "shopping-env"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{run_hash}.json"


def _read_cursor(context: dict[str, Any], category: str) -> dict[str, Any]:
    path = _cursor_path(context)
    if not path.exists():
        return {"mapping_version": MARKET_MAPPING_VERSION, "category": category, "selected_ids": []}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise ValueError(f"shopping cursor cannot be read: {error}") from error
    if not isinstance(value, dict) or value.get("mapping_version") != MARKET_MAPPING_VERSION or value.get("category") != category:
        raise ValueError("shopping cursor category does not match the active route")
    selected = value.get("selected_ids")
    if not isinstance(selected, list) or not all(isinstance(item, str) and item for item in selected):
        raise ValueError("shopping cursor selected_ids is invalid")
    if len(set(selected)) != len(selected):
        raise ValueError("shopping cursor contains duplicate item ids")
    return {"mapping_version": MARKET_MAPPING_VERSION, "category": category, "selected_ids": list(selected)}


def read_cursor(context: dict[str, Any], category: str | None = None) -> dict[str, Any]:
    """Read trusted sampling state for validators without changing it."""

    if category is None:
        _, category = active_market_route(context)
    return _read_cursor(context, category)


def _write_cursor(context: dict[str, Any], cursor: dict[str, Any]) -> None:
    path = _cursor_path(context)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_path = tempfile.mkstemp(prefix=f".{path.stem}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as destination:
            json.dump(cursor, destination, ensure_ascii=False, separators=(",", ":"))
            destination.write("\n")
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(raw_path, path)
    except Exception:
        try:
            os.unlink(raw_path)
        except OSError:
            pass
        raise


def _rows(context: dict[str, Any], category: str) -> list[dict[str, Any]]:
    dataset = _dataset_path(context)
    if not dataset.is_file():
        raise ValueError(f"configured product dataset does not exist: {dataset}")
    try:
        table = parquet.read_table(dataset, columns=["item_id", "category", "rank", "context_text"])
        rows = table.to_pylist()
    except Exception as error:
        raise ValueError(f"product dataset read failed: {error}") from error
    candidates: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict) or row.get("category") != category:
            continue
        item_id = row.get("item_id")
        context_text = row.get("context_text")
        if not isinstance(item_id, str) or not item_id or not re.fullmatch(r"[A-Za-z0-9._-]+", item_id):
            raise ValueError("product dataset contains an invalid item_id")
        if not isinstance(context_text, str):
            raise ValueError(f"product dataset row {item_id} has no context_text")
        rank = row.get("rank")
        candidates.append({"item_id": item_id, "category": category, "rank": rank, "ocr_text": context_text})
    # The dataset currently has rank values, but sorting by item_id as a tie
    # breaker gives a documented stable order if rank is duplicated or absent.
    candidates.sort(key=lambda item: (item["rank"] is None, item["rank"] if isinstance(item["rank"], int) else 0, item["item_id"]))
    if not candidates:
        raise ValueError(f"no products found for dataset category {category}")
    return candidates


def _find_row(context: dict[str, Any], category: str, item_id: str) -> dict[str, Any]:
    for row in _rows(context, category):
        if row["item_id"] == item_id:
            return row
    raise ValueError(f"item_id {item_id} is not present in dataset category {category}")


def validate_selected_ids(context: dict[str, Any], category: str, selected_ids: list[str]) -> None:
    """Validate product ids against the trusted parquet source without moving the cursor."""

    available = {row["item_id"] for row in _rows(context, category)}
    missing = [item_id for item_id in selected_ids if item_id not in available]
    if missing:
        raise ValueError(f"selected item ids are not present in dataset category {category}: {missing}")


def selected_product_contexts(context: dict[str, Any], category: str, selected_ids: list[str]) -> dict[str, str]:
    """Return trusted full OCR context for selected ids without advancing the cursor."""

    rows = {row["item_id"]: row["ocr_text"] for row in _rows(context, category)}
    missing = [item_id for item_id in selected_ids if item_id not in rows]
    if missing:
        raise ValueError(f"selected item ids are not present in dataset category {category}: {missing}")
    return {item_id: rows[item_id] for item_id in selected_ids}


def next_product(context: dict[str, Any]) -> dict[str, Any]:
    _, category = active_market_route(context)
    cursor = _read_cursor(context, category)
    limit = max_distinct_products(context)
    selected = cursor["selected_ids"]
    if len(selected) >= limit:
        raise ValueError("sample_exhausted")
    selected_set = set(selected)
    row = next((candidate for candidate in _rows(context, category) if candidate["item_id"] not in selected_set), None)
    if row is None:
        raise ValueError(f"dataset category {category} has fewer than {limit} products")
    # Only advance after the row and its full OCR context have been read.
    updated = {"mapping_version": MARKET_MAPPING_VERSION, "category": category, "selected_ids": [*selected, row["item_id"]]}
    _write_cursor(context, updated)
    return {
        "dataset_category": category,
        "sample_index": len(updated["selected_ids"]),
        "sample_limit": limit,
        **row,
    }


def reread_product(context: dict[str, Any], item_id: str) -> dict[str, Any]:
    item_id = _required_text(item_id, "item_id")
    _, category = active_market_route(context)
    cursor = _read_cursor(context, category)
    if item_id not in set(cursor["selected_ids"]):
        raise ValueError("item_id was not selected in this market run")
    row = _find_row(context, category, item_id)
    return {
        "dataset_category": category,
        "sample_index": cursor["selected_ids"].index(item_id) + 1,
        "sample_limit": max_distinct_products(context),
        **row,
    }


def shopping_env(arguments: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(arguments, dict) or arguments:
        raise ValueError("shopping_env accepts only an empty object")
    return next_product(context)
