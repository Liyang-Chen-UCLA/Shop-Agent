"""Trusted validation and persistence for the canonical Market contract.

The Market agent maintains its working state through framework-owned state
tools. This module only publishes that state after the trusted sampling cursor
and taxonomy route have been checked. Product extraction results stay in tool
observations; they are not published as product files or a matrix.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))

from criteria_contract import validate_criteria_document
from market_mapping import dataset_category_for_node
from shopping_env_common import (
    active_market_route,
    max_distinct_products,
    read_cursor,
    validate_selected_ids,
)


NODE_KEYS = {"id", "name", "path"}
RUNTIME_ITEM_FIELD = "observed_product_ids"
SAFE_PRODUCT_ID = re.compile(r"[A-Za-z0-9._-]+")


def _error(message: str) -> ValueError:
    return ValueError(message[:1_000])


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _error(f"{label} must be a non-empty string")
    return value.strip()


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _error(f"{label} must be an object")
    return value


def _list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise _error(f"{label} must be an array")
    return value


def _node_and_route(candidate: Any, context: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], str]:
    document = _object(candidate, "document")
    node = _object(document.get("node"), "node")
    if set(node) != NODE_KEYS:
        raise _error("node must contain exactly id, name, and path")
    route, category = active_market_route(context)
    node_id = _text(node.get("id"), "node.id")
    node_name = _text(node.get("name"), "node.name")
    node_path = _list(node.get("path"), "node.path")
    if node_id != route["node_id"]:
        raise _error("document node.id does not match the active route")
    if node_name != route["node_name"]:
        raise _error("document node.name does not match the active route")
    expected_path = [part.strip() for part in route["node_path"].split(">") if part.strip()]
    if node_path != expected_path:
        raise _error("document node.path does not match the active route")
    if not re.fullmatch(r"[0-9]+", node_id):
        raise _error("node.id must be a numeric taxonomy identifier")
    dataset_category_for_node(node_id)
    return node, route, category


def _criteria_document(candidate: Any, context: dict[str, Any]) -> dict[str, Any]:
    document = _object(candidate, "document")
    if set(document) != {"node", "criteria", "attributes"}:
        raise _error("base document must contain exactly node, criteria, and attributes")
    _node_and_route(document, context)
    try:
        validated = validate_criteria_document(document)
    except Exception as error:
        raise _error(f"criteria contract rejected document: {error}") from error
    return validated.model_dump(mode="json")


def _artifact_directory(context: dict[str, Any], node_id: str) -> Path:
    data = _text(context.get("dataDirectory"), "trusted data directory")
    return Path(data).resolve() / "market-criteria" / node_id


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as destination:
            json.dump(value, destination, ensure_ascii=False, indent=2)
            destination.write("\n")
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(raw, path)
    except Exception:
        try:
            os.unlink(raw)
        except OSError:
            pass
        raise


def persist_base(candidate: Any, context: dict[str, Any]) -> dict[str, Any]:
    normalized = _criteria_document(candidate, context)
    directory = _artifact_directory(context, normalized["node"]["id"])
    _atomic_json(directory / "base.json", normalized)
    return normalized


def load_market(context: dict[str, Any]) -> dict[str, Any]:
    route, _ = active_market_route(context)
    path = _artifact_directory(context, route["node_id"]) / "market.json"
    if not path.is_file():
        raise _error(f"market artifact is not available for taxonomy node {route['node_id']}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise _error(f"market artifact cannot be read: {error}") from error
    if not isinstance(value, dict) or set(value) != {"node", "criteria", "attributes"}:
        raise _error("market artifact has an invalid canonical shape")
    return value


def _trusted_sample_ids(context: dict[str, Any], category: str) -> list[str]:
    limit = max_distinct_products(context)
    cursor = read_cursor(context, category)
    selected = cursor.get("selected_ids")
    if not isinstance(selected, list) or len(selected) != limit:
        raise _error(f"shopping_env must complete exactly {limit} trusted samples before market finalization")
    if not all(isinstance(item_id, str) and SAFE_PRODUCT_ID.fullmatch(item_id) for item_id in selected):
        raise _error("trusted shopping_env selected_ids contains an invalid product id")
    if len(set(selected)) != len(selected):
        raise _error("trusted shopping_env selected_ids must be unique")
    try:
        validate_selected_ids(context, category, selected)
    except Exception as error:
        raise _error(f"trusted shopping_env selection is invalid: {error}") from error
    return list(selected)


def _definitions_with_runtime(
    candidate: dict[str, Any],
    selected_ids: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[tuple[str, str], list[str]]]:
    selected = set(selected_ids)
    seen: set[str] = set()
    runtime_by_item: dict[tuple[str, str], list[str]] = {}
    definitions: dict[str, list[dict[str, Any]]] = {"criteria": [], "attributes": []}

    for kind in ("criteria", "attributes"):
        raw_items = _list(candidate.get(kind), kind)
        for index, raw_item in enumerate(raw_items):
            item = _object(raw_item, f"{kind}[{index}]")
            observed_raw = _list(item.get(RUNTIME_ITEM_FIELD), f"{kind}[{index}].{RUNTIME_ITEM_FIELD}")
            observed: list[str] = []
            for observed_index, product_id in enumerate(observed_raw):
                if not isinstance(product_id, str) or not SAFE_PRODUCT_ID.fullmatch(product_id):
                    raise _error(f"{kind}[{index}].{RUNTIME_ITEM_FIELD}[{observed_index}] is not a valid product id")
                if product_id in observed:
                    raise _error(f"{kind}[{index}].{RUNTIME_ITEM_FIELD} must be unique")
                if product_id not in selected:
                    raise _error(f"{kind}[{index}].{RUNTIME_ITEM_FIELD} references a product not sampled in this run")
                observed.append(product_id)
            definition = {key: value for key, value in item.items() if key != RUNTIME_ITEM_FIELD}
            item_id = _text(definition.get("id"), f"{kind}[{index}].id")
            if item_id in seen:
                raise _error(f"item id occurs more than once in the global contract namespace: {item_id}")
            seen.add(item_id)
            definitions[kind].append(definition)
            runtime_by_item[(kind, item_id)] = observed
    return definitions["criteria"], definitions["attributes"], runtime_by_item


def publish_market(candidate: Any, context: dict[str, Any]) -> dict[str, Any]:
    document = _object(candidate, "market document")
    if set(document) != {"node", "criteria", "attributes"}:
        raise _error("market document must contain exactly node, criteria, and attributes")
    node, route, category = _node_and_route(document, context)
    selected_ids = _trusted_sample_ids(context, category)
    criteria, attributes, runtime_by_item = _definitions_with_runtime(document, selected_ids)
    definition_document = {"node": node, "criteria": criteria, "attributes": attributes}
    try:
        validated = validate_criteria_document(definition_document).model_dump(mode="json")
    except Exception as error:
        raise _error(f"market criteria/attribute definition rejected: {error}") from error

    market_document = {
        "node": validated["node"],
        "criteria": [
            {**item, RUNTIME_ITEM_FIELD: runtime_by_item[("criteria", item["id"])]}
            for item in validated["criteria"]
        ],
        "attributes": [
            {**item, RUNTIME_ITEM_FIELD: runtime_by_item[("attributes", item["id"])]}
            for item in validated["attributes"]
        ],
    }
    _atomic_json(_artifact_directory(context, route["node_id"]) / "market.json", market_document)
    return market_document


def handle(value: Any, context: dict[str, Any]) -> Any:
    operation = context.get("operation", "publish_market")
    if operation == "persist_base":
        return persist_base(value, context)
    if operation == "publish_market":
        return publish_market(value, context)
    if operation == "load_market":
        return load_market(context)
    raise _error("unknown market contract operation")


def _protocol() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise _error("validator payload must be an object")
        value = payload.get("value")
        context = payload.get("context", {})
        if not isinstance(context, dict):
            raise _error("validator context must be an object")
        result = handle(value, context)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": {"code": "MARKET_VALIDATION_ERROR", "message": str(error)[:6_000]}}, ensure_ascii=False, separators=(",", ":")))
        return 0


if __name__ == "__main__":
    raise SystemExit(_protocol())
