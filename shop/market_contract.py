"""Trusted validation and persistence for category market analysis.

The market model can see only ``load_base`` and ``shopping_env`` (plus the
bounded native web search).  This module is invoked by the framework after a
candidate JSON result and is therefore the authority for route identity,
sampling, extraction coverage, frequencies, and publication order.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from copy import deepcopy
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
    selected_product_contexts,
    validate_selected_ids,
)


ALIGNMENTS = {"matched", "corrected_from_conflict", "added_from_market"}
STATUSES = {"observed", "unparsed", "not_mentioned"}
VALUE_KEYS = {"raw_value", "normalized_value", "unit", "qualifier", "evidence", "ocr_page_id"}
MARKET_ITEM_METADATA = {"observed_product_count", "market_alignment", "web_evidence"}
NODE_KEYS = {"id", "name", "path"}


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
    # All configured route ids are numeric.  Keep the artifact path bounded
    # even if a future taxonomy source contains unusual IDs.
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
    base = Path(data).resolve()
    return base / "market-criteria" / node_id


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
    node_id = normalized["node"]["id"]
    directory = _artifact_directory(context, node_id)
    _atomic_json(directory / "base.json", normalized)
    return normalized


def _load_base(context: dict[str, Any], node_id: str) -> dict[str, Any]:
    path = _artifact_directory(context, node_id) / "base.json"
    if not path.is_file():
        raise _error(f"base criteria artifact is not available for taxonomy node {node_id}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise _error(f"base criteria artifact cannot be read: {error}") from error
    # Revalidate the persisted artifact against the active route before using
    # it.  This prevents a stale or manually altered file from becoming model
    # context.
    return _criteria_document(value, context)


def load_market(context: dict[str, Any]) -> dict[str, Any]:
    _, route, _ = _node_and_route({"node": {
        "id": active_market_route(context)[0]["node_id"],
        "name": active_market_route(context)[0]["node_name"],
        "path": [part.strip() for part in active_market_route(context)[0]["node_path"].split(">") if part.strip()],
    }}, context)
    path = _artifact_directory(context, route["node_id"]) / "market.json"
    if not path.is_file():
        raise _error(f"market artifact is not available for taxonomy node {route['node_id']}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise _error(f"market artifact cannot be read: {error}") from error
    if not isinstance(value, dict):
        raise _error("market artifact has an invalid shape")
    return value


def _evidence(value: Any, label: str) -> list[Any]:
    entries = _list(value, label)
    normalized: list[Any] = []
    for index, entry in enumerate(entries):
        if isinstance(entry, str):
            if entry.strip():
                normalized.append(entry.strip())
            else:
                raise _error(f"{label}[{index}] must not be empty")
            continue
        if not isinstance(entry, dict) or not entry:
            raise _error(f"{label}[{index}] must be a non-empty object or string")
        for key in entry:
            if key not in {"source", "url", "title", "claim", "evidence"}:
                raise _error(f"{label}[{index}].{key} is not allowed")
            if not isinstance(entry[key], str) or not entry[key].strip():
                raise _error(f"{label}[{index}].{key} must be non-empty text")
        normalized.append({key: value.strip() for key, value in entry.items()})
    return normalized


def _strip_metadata(item: Any, label: str) -> dict[str, Any]:
    raw = _object(item, label)
    stripped = {key: value for key, value in raw.items() if key not in MARKET_ITEM_METADATA}
    return stripped


def _market_items(candidate: dict[str, Any], base: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, Any]]]:
    final_criteria = _list(candidate.get("criteria"), "criteria")
    final_attributes = _list(candidate.get("attributes"), "attributes")
    base_criteria = {item["id"]: item for item in base["criteria"]}
    base_attributes = {item["id"]: item for item in base["attributes"]}
    base_by_kind = {"criteria": base_criteria, "attributes": base_attributes}
    all_final: dict[str, dict[str, Any]] = {}
    normalized_by_kind: dict[str, list[dict[str, Any]]] = {"criteria": [], "attributes": []}
    changed_count = 0

    for kind, raw_items in (("criteria", final_criteria), ("attributes", final_attributes)):
        seen: set[str] = set()
        for index, raw in enumerate(raw_items):
            item = _object(raw, f"{kind}[{index}]")
            if set(MARKET_ITEM_METADATA) - set(item):
                raise _error(f"{kind}[{index}] must include market_alignment, observed_product_count, and web_evidence")
            stripped = _strip_metadata(item, f"{kind}[{index}]")
            item_id = _text(stripped.get("id"), f"{kind}[{index}].id")
            if item_id in seen:
                raise _error(f"duplicate {kind} item id {item_id}")
            seen.add(item_id)
            if item_id in all_final:
                raise _error(f"item id occurs in both criteria and attributes: {item_id}")
            alignment = item.get("market_alignment")
            if alignment not in ALIGNMENTS:
                raise _error(f"{kind}[{index}].market_alignment is invalid")
            evidence = _evidence(item.get("web_evidence"), f"{kind}[{index}].web_evidence")
            if item_id in base_by_kind[kind]:
                if alignment not in {"matched", "corrected_from_conflict"}:
                    raise _error(f"base {kind} item {item_id} cannot be marked added_from_market")
                if alignment == "corrected_from_conflict":
                    changed_count += 1
                    if not evidence:
                        raise _error(f"corrected item {item_id} requires web_evidence")
            else:
                if alignment != "added_from_market":
                    raise _error(f"non-base {kind} item {item_id} must be marked added_from_market")
                changed_count += 1
                if not evidence:
                    raise _error(f"market-added item {item_id} requires web_evidence")
            normalized_by_kind[kind].append(stripped)
            all_final[item_id] = {
                "kind": kind,
                "definition": stripped,
                "alignment": alignment,
                "web_evidence": evidence,
                "raw_observed_product_count": item.get("observed_product_count"),
            }

        missing = set(base_by_kind[kind]) - seen
        if missing:
            raise _error(f"base {kind} items were omitted: {sorted(missing)}")

    final_document = {"node": base["node"], "criteria": normalized_by_kind["criteria"], "attributes": normalized_by_kind["attributes"]}
    try:
        validated_final = validate_criteria_document(final_document)
    except Exception as error:
        raise _error(f"final criteria/attribute contract rejected document: {error}") from error
    canonical_by_kind = {
        "criteria": {item["id"]: item for item in validated_final.model_dump(mode="json")["criteria"]},
        "attributes": {item["id"]: item for item in validated_final.model_dump(mode="json")["attributes"]},
    }
    for kind, base_items in base_by_kind.items():
        for item_id, base_item in base_items.items():
            metadata = all_final[item_id]
            if metadata["alignment"] == "matched" and canonical_by_kind[kind][item_id] != base_item:
                raise _error(f"matched base item {item_id} may not change its definition")
    return list(canonical_by_kind["criteria"].values()), list(canonical_by_kind["attributes"].values()), all_final


def _nullable_text(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _error(f"{label} must be text or null")
    return value.strip() or None


def _normalized_value(value: Any, label: str) -> str | int | float | bool | None:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise _error(f"{label} must be a scalar or null")


def _values(raw_values: Any, status: str, label: str, ocr_text: str) -> list[dict[str, Any]]:
    values = _list(raw_values, label)
    if status == "not_mentioned":
        if values:
            raise _error(f"{label} must be empty for not_mentioned")
        return []
    if not values:
        raise _error(f"{label} must contain evidence for {status}")
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(values):
        value = _object(raw, f"{label}[{index}]")
        unknown = set(value) - VALUE_KEYS
        if unknown:
            raise _error(f"{label}[{index}] contains unsupported fields: {sorted(unknown)}")
        raw_value = value.get("raw_value")
        if not isinstance(raw_value, str) or not raw_value.strip():
            raise _error(f"{label}[{index}].raw_value must be non-empty text")
        parsed = _normalized_value(value.get("normalized_value"), f"{label}[{index}].normalized_value")
        if status == "unparsed" and parsed is not None:
            raise _error(f"{label}[{index}].normalized_value must be null for unparsed")
        if status == "observed" and parsed is None:
            raise _error(f"{label}[{index}].normalized_value must be non-null for observed")
        evidence = _nullable_text(value.get("evidence"), f"{label}[{index}].evidence")
        if evidence is None:
            raise _error(f"{label}[{index}].evidence must be non-empty for {status}")
        if evidence not in ocr_text:
            raise _error(f"{label}[{index}].evidence is not a verbatim substring of the trusted OCR context")
        normalized.append({
            "raw_value": raw_value.strip(),
            "normalized_value": parsed,
            "unit": _nullable_text(value.get("unit"), f"{label}[{index}].unit"),
            "qualifier": _nullable_text(value.get("qualifier"), f"{label}[{index}].qualifier"),
            "evidence": evidence,
            "ocr_page_id": _nullable_text(value.get("ocr_page_id"), f"{label}[{index}].ocr_page_id"),
        })
    return normalized


def _product_entries(
    raw: Any,
    item_ids: set[str],
    label: str,
    ocr_text: str,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, int]]:
    entries = _list(raw, label)
    seen: set[str] = set()
    normalized: dict[str, list[dict[str, Any]]] = {}
    frequencies: dict[str, int] = {}
    for index, entry_raw in enumerate(entries):
        entry = _object(entry_raw, f"{label}[{index}]")
        if set(entry) != {"item_id", "status", "values"}:
            raise _error(f"{label}[{index}] must contain exactly item_id, status, and values")
        item_id = _text(entry.get("item_id"), f"{label}[{index}].item_id")
        if item_id not in item_ids:
            raise _error(f"{label}[{index}] references an unknown final item {item_id}")
        if item_id in seen:
            raise _error(f"{label} contains duplicate item {item_id}")
        seen.add(item_id)
        status = entry.get("status")
        if status not in STATUSES:
            raise _error(f"{label}[{index}].status is invalid")
        item_values = _values(entry.get("values"), status, f"{label}[{index}].values", ocr_text)
        normalized[item_id] = {"item_id": item_id, "status": status, "values": item_values}
        frequencies[item_id] = int(status in {"observed", "unparsed"})
    missing = item_ids - seen
    if missing:
        raise _error(f"{label} is missing final items: {sorted(missing)}")
    return normalized, frequencies


def _products(
    candidate: dict[str, Any],
    selected_ids: list[str],
    criteria_ids: set[str],
    attribute_ids: set[str],
    category: str,
    contexts: dict[str, str],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    raw_products = _list(candidate.get("products"), "products")
    if len(raw_products) != len(selected_ids):
        raise _error(f"products must contain exactly {len(selected_ids)} selected items")
    by_item: dict[str, dict[str, Any]] = {}
    final_ids = criteria_ids | attribute_ids
    frequency: dict[str, int] = {item_id: 0 for item_id in final_ids}
    for index, raw in enumerate(raw_products):
        product = _object(raw, f"products[{index}]")
        allowed = {"dataset_category", "item_id", "criteria", "attributes"}
        if set(product) != allowed:
            raise _error(f"products[{index}] has an invalid shape")
        if product.get("dataset_category") != category:
            raise _error(f"products[{index}].dataset_category does not match the mapped category")
        item_id = _text(product.get("item_id"), f"products[{index}].item_id")
        if item_id not in selected_ids:
            raise _error(f"products[{index}] references an unselected product {item_id}")
        if item_id in by_item:
            raise _error(f"products contains duplicate product {item_id}")
        ocr_text = contexts[item_id]
        criteria_entries, _criteria_frequency = _product_entries(product.get("criteria"), criteria_ids, f"products[{index}].criteria", ocr_text)
        attributes_entries, _attributes_frequency = _product_entries(product.get("attributes"), attribute_ids, f"products[{index}].attributes", ocr_text)
        # The item namespace is global across criteria and attributes.  The
        # contract validator above rejects cross-array collisions, so merge
        # both lists into one file-level representation while counting each
        # final item at most once.
        if set(criteria_entries) & set(attributes_entries):
            raise _error(f"products[{index}] repeats an item across criteria and attributes")
        entries = {**criteria_entries, **attributes_entries}
        if set(entries) != final_ids:
            raise _error(f"products[{index}] does not cover every final item")
        for final_id in final_ids:
            status = entries[final_id]["status"]
            if status in {"observed", "unparsed"}:
                frequency[final_id] += 1
        by_item[item_id] = {
            "dataset_category": category,
            "item_id": item_id,
            "criteria": [criteria_entries[item_id] for item_id in criteria_entries if item_id in criteria_entries],
            "attributes": [attributes_entries[item_id] for item_id in attributes_entries if item_id in attributes_entries],
        }
    missing = set(selected_ids) - set(by_item)
    if missing:
        raise _error(f"products are missing selected items: {sorted(missing)}")
    return [by_item[item_id] for item_id in selected_ids], frequency


def publish_market(candidate: Any, context: dict[str, Any]) -> dict[str, Any]:
    candidate = _object(candidate, "market document")
    required = {"node", "dataset_category", "traversed_product_count", "product_ids", "criteria", "attributes", "products"}
    if set(candidate) != required:
        raise _error("market result must contain node, dataset_category, traversed_product_count, product_ids, criteria, attributes, and products")
    node, route, category = _node_and_route(candidate, context)
    if candidate.get("dataset_category") != category:
        raise _error("dataset_category does not match the active route mapping")
    limit = max_distinct_products(context)
    selected_ids = _list(candidate.get("product_ids"), "product_ids")
    if len(selected_ids) != limit or not all(isinstance(item, str) and re.fullmatch(r"[A-Za-z0-9._-]+", item) for item in selected_ids):
        raise _error(f"product_ids must contain exactly {limit} non-empty strings")
    if len(set(selected_ids)) != len(selected_ids):
        raise _error("product_ids must be distinct")
    if candidate.get("traversed_product_count") != limit:
        raise _error(f"traversed_product_count must be exactly {limit}")
    cursor = read_cursor(context, category)
    if cursor.get("selected_ids") != selected_ids:
        raise _error("product_ids must exactly match the trusted shopping_env selection order")
    validate_selected_ids(context, category, selected_ids)
    contexts = selected_product_contexts(context, category, selected_ids)
    base = _load_base(context, route["node_id"])
    criteria, attributes, final_items = _market_items(candidate, base)
    products, frequencies = _products(
        candidate,
        selected_ids,
        {item["id"] for item in criteria},
        {item["id"] for item in attributes},
        category,
        contexts,
    )

    changed = [item for item in final_items.values() if item["alignment"] in {"corrected_from_conflict", "added_from_market"}]
    stats = context.get("searchStats")
    succeeded = stats.get("succeeded", 0) if isinstance(stats, dict) else 0
    if changed and (not isinstance(succeeded, int) or succeeded < len(changed)):
        raise _error("web_search must complete for every corrected or market-added item")
    for item_id, metadata in final_items.items():
        if metadata["alignment"] == "added_from_market" and frequencies.get(item_id, 0) <= 0:
            raise _error(f"market-added item {item_id} is absent from all selected OCR contexts")

    market_items: dict[str, dict[str, Any]] = {}
    for item in [*criteria, *attributes]:
        item_id = item["id"]
        metadata = final_items[item_id]
        market_items[item_id] = {
            **deepcopy(item),
            "observed_product_count": frequencies.get(item_id, 0),
            "market_alignment": metadata["alignment"],
            "web_evidence": metadata["web_evidence"],
        }
    market_document = {
        "node": deepcopy(node),
        "dataset_category": category,
        "traversed_product_count": limit,
        "product_ids": list(selected_ids),
        "criteria": [market_items[item["id"]] for item in criteria],
        "attributes": [market_items[item["id"]] for item in attributes],
    }
    directory = _artifact_directory(context, route["node_id"])
    products_directory = directory / "products"
    products_directory.mkdir(parents=True, exist_ok=True)
    # Product files are durable before the market index.  The index is the
    # publication marker, so a failed validation or write never advertises a
    # partially validated market result.
    for product in products:
        _atomic_json(products_directory / f"{product['item_id']}.json", product)
    # Remove stale generated product files only after all current files have
    # been written successfully.  The directory is an application-owned
    # artifact location, and stale files would violate the configured sample
    # limit.
    for stale in products_directory.glob("*.json"):
        if stale.stem not in set(selected_ids):
            try:
                stale.unlink()
            except OSError as error:
                raise _error(f"cannot remove stale product artifact {stale.name}: {error}") from error
    _atomic_json(directory / "market.json", market_document)
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
