"""Authoritative Pydantic contract for transient category criteria results.

This module deliberately owns the semantic rules for criteria-agent output.  The
TypeScript profile schema is only an inexpensive first-pass guard; callers that
need a trusted result should call :func:`validate_criteria_document` (or use the
small JSON-line protocol exposed by this file).
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from typing import Annotated, Literal, TypeAlias, Union

from pydantic import BaseModel, ConfigDict, Field, StrictStr, ValidationError, field_validator, model_validator


class _ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _text(value: StrictStr) -> str:
    value = value.strip()
    if not value:
        raise ValueError("must be a non-empty string")
    return value


def _id(value: StrictStr) -> str:
    value = _text(value)
    if not re.fullmatch(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*", value):
        raise ValueError("must be an English snake_case identifier")
    return value


def _list_text(value: list[StrictStr]) -> list[str]:
    return [_text(item) for item in value]


def _unique(values: list[str], label: str) -> list[str]:
    if len({_normalize(item) for item in values}) != len(values):
        raise ValueError(f"{label} must contain unique values")
    return values


def _non_empty_unique(values: list[str], label: str) -> list[str]:
    if not values:
        raise ValueError(f"{label} must contain at least one value")
    return _unique(values, label)


def _normalize(value: str) -> str:
    """Normalize labels for collision checks without changing stored display text."""

    normalized = unicodedata.normalize("NFKC", value).casefold()
    # Treat punctuation, separators, and underscores as equivalent whitespace.
    normalized = "".join(character if character.isalnum() else " " for character in normalized)
    return " ".join(normalized.split())


class LargerBetter(_ContractModel):
    type: Literal["larger_better"]


class SmallerBetter(_ContractModel):
    type: Literal["smaller_better"]


class TargetRange(_ContractModel):
    type: Literal["target_range"]
    unit: StrictStr

    _unit = field_validator("unit")(_text)


NumericDirection: TypeAlias = Annotated[
    Union[LargerBetter, SmallerBetter, TargetRange],
    Field(discriminator="type"),
]


class TrueBetter(_ContractModel):
    type: Literal["true_better"]


class FalseBetter(_ContractModel):
    type: Literal["false_better"]


BooleanDirection: TypeAlias = Annotated[
    Union[TrueBetter, FalseBetter],
    Field(discriminator="type"),
]


class TotalOrder(_ContractModel):
    type: Literal["total_order"]
    order: list[StrictStr]

    _order_text = field_validator("order")(_list_text)


class PartialOrder(_ContractModel):
    type: Literal["partial_order"]
    better_than: list[tuple[StrictStr, StrictStr]]

    @field_validator("better_than")
    @classmethod
    def _edges(cls, value: list[tuple[StrictStr, StrictStr]]) -> list[tuple[str, str]]:
        if not value:
            raise ValueError("better_than must contain at least one edge")
        edges: list[tuple[str, str]] = []
        for edge in value:
            if len(edge) != 2:
                raise ValueError("better_than edges must contain exactly two values")
            left, right = _text(edge[0]), _text(edge[1])
            edges.append((left, right))
        return edges


class PreferredSet(_ContractModel):
    type: Literal["preferred_set"]
    values: list[StrictStr]

    _values_text = field_validator("values")(_list_text)


CategoricalDirection: TypeAlias = Annotated[
    Union[TotalOrder, PartialOrder, PreferredSet],
    Field(discriminator="type"),
]


class _CommonItem(_ContractModel):
    id: StrictStr
    name: StrictStr
    description: StrictStr
    aliases: list[StrictStr]

    _item_id = field_validator("id")(_id)
    _item_text = field_validator("name", "description")(_text)
    _aliases_text = field_validator("aliases")(_list_text)


class NumericCriterion(_CommonItem):
    type: Literal["numeric"]
    units: list[StrictStr]
    formula: StrictStr | None = None
    direction: NumericDirection

    _units_text = field_validator("units")(_list_text)

    @field_validator("units")
    @classmethod
    def _units_unique(cls, value: list[str]) -> list[str]:
        return _unique(value, "units")

    @field_validator("formula")
    @classmethod
    def _formula_text(cls, value: StrictStr | None) -> str | None:
        return None if value is None else _text(value)

    @model_validator(mode="after")
    def _target_unit_exists(self) -> "NumericCriterion":
        if isinstance(self.direction, TargetRange) and self.direction.unit not in self.units:
            raise ValueError("target_range.unit must occur in non-empty units")
        return self


class BooleanCriterion(_CommonItem):
    type: Literal["boolean"]
    direction: BooleanDirection


class CategoricalCriterion(_CommonItem):
    type: Literal["categorical"]
    values: list[StrictStr]
    value_domain: Literal["open", "closed"]
    direction: CategoricalDirection

    _values_text = field_validator("values")(_list_text)

    @field_validator("values")
    @classmethod
    def _values_non_empty_unique(cls, value: list[str]) -> list[str]:
        return _non_empty_unique(value, "values")

    @model_validator(mode="after")
    def _direction_matches_values(self) -> "CategoricalCriterion":
        values = _unique(self.values, "values")
        value_set = set(values)
        direction = self.direction
        if isinstance(direction, TotalOrder):
            if self.value_domain != "closed":
                raise ValueError("total_order is only valid for a closed value_domain")
            if len(self.values) < 2:
                raise ValueError("total_order requires at least two values")
            if len(direction.order) < 2:
                raise ValueError("total_order.order must contain at least two values")
            if len(direction.order) != len(set(direction.order)) or set(direction.order) != value_set:
                raise ValueError("total_order.order must exactly and uniquely cover values")
        elif isinstance(direction, PartialOrder):
            edges = direction.better_than
            seen: set[tuple[str, str]] = set()
            adjacency: dict[str, list[str]] = {value: [] for value in values}
            for better, worse in edges:
                if better not in value_set or worse not in value_set:
                    raise ValueError("partial_order endpoints must occur in values")
                if better == worse:
                    raise ValueError("partial_order cannot contain self-edges")
                edge = (better, worse)
                if edge in seen:
                    raise ValueError("partial_order cannot contain duplicate edges")
                seen.add(edge)
                adjacency[better].append(worse)
            # Deterministic DFS: sorting both vertices and adjacency makes the
            # reported cycle behavior independent of JSON/list insertion order.
            state: dict[str, int] = {value: 0 for value in values}

            def visit(vertex: str) -> None:
                state[vertex] = 1
                for child in sorted(adjacency[vertex]):
                    if state[child] == 1:
                        raise ValueError("partial_order graph must be acyclic")
                    if state[child] == 0:
                        visit(child)
                state[vertex] = 2

            for vertex in sorted(values):
                if state[vertex] == 0:
                    visit(vertex)
        elif isinstance(direction, PreferredSet):
            if not direction.values:
                raise ValueError("preferred_set.values must be non-empty")
            if len(direction.values) != len({_normalize(value) for value in direction.values}):
                raise ValueError("preferred_set.values must be unique")
            if not set(direction.values).issubset(value_set):
                raise ValueError("preferred_set.values must reference values")
            if self.value_domain == "closed" and set(direction.values) == value_set:
                raise ValueError("preferred_set must not cover every value in a closed domain")
        return self


class NumericAttribute(_CommonItem):
    type: Literal["numeric"]
    units: list[StrictStr]
    formula: StrictStr | None = None

    _units_text = field_validator("units")(_list_text)

    @field_validator("units")
    @classmethod
    def _units_unique(cls, value: list[str]) -> list[str]:
        return _unique(value, "units")

    @field_validator("formula")
    @classmethod
    def _formula_text(cls, value: StrictStr | None) -> str | None:
        return None if value is None else _text(value)


class BooleanAttribute(_CommonItem):
    type: Literal["boolean"]


class CategoricalAttribute(_CommonItem):
    type: Literal["categorical"]
    values: list[StrictStr]
    value_domain: Literal["open", "closed"]

    _values_text = field_validator("values")(_list_text)

    @field_validator("values")
    @classmethod
    def _values_unique(cls, value: list[str]) -> list[str]:
        return _non_empty_unique(value, "values")


CriteriaItem: TypeAlias = Annotated[
    Union[NumericCriterion, BooleanCriterion, CategoricalCriterion],
    Field(discriminator="type"),
]
AttributeItem: TypeAlias = Annotated[
    Union[NumericAttribute, BooleanAttribute, CategoricalAttribute],
    Field(discriminator="type"),
]


class CriteriaNode(_ContractModel):
    id: StrictStr
    name: StrictStr
    path: list[StrictStr]

    _node_text = field_validator("id", "name")(_text)
    _node_path = field_validator("path")(_list_text)


class CriteriaDocument(_ContractModel):
    node: CriteriaNode
    criteria: list[CriteriaItem]
    attributes: list[AttributeItem]

    @model_validator(mode="after")
    def _global_namespace(self) -> "CriteriaDocument":
        seen: dict[str, str] = {}
        for kind, items in (("criteria", self.criteria), ("attributes", self.attributes)):
            for index, item in enumerate(items):
                item_key = f"{kind}[{index}]"
                alias_names: set[str] = set()
                for alias in item.aliases:
                    normalized_alias = _normalize(alias)
                    if normalized_alias in alias_names:
                        raise ValueError(f"{item_key}.aliases must be unique after normalization")
                    alias_names.add(normalized_alias)
                # Labels belonging to one item may intentionally be equivalent
                # (for example an id and its human-readable alias). They still
                # reserve one shared namespace against every other item.
                labels = [item.id, item.name, *item.aliases]
                item_labels: set[str] = set()
                for label in labels:
                    normalized = _normalize(label)
                    if not normalized:
                        raise ValueError(f"{item_key} label must not be empty")
                    if normalized in item_labels:
                        continue
                    item_labels.add(normalized)
                    previous = seen.get(normalized)
                    if previous is not None and previous != item_key:
                        raise ValueError(f"label collision after normalization: {previous} and {item_key}::{label}")
                    seen[normalized] = item_key
        return self


def validate_criteria_document(value: object) -> CriteriaDocument:
    """Validate and return a typed criteria document."""

    return CriteriaDocument.model_validate(value)


# Friendly aliases for callers that use the shorter contract terminology.
CriteriaResult = CriteriaDocument
CriteriaContract = CriteriaDocument
validate_criteria = validate_criteria_document


def _safe_error(error: ValidationError) -> str:
    # Keep the subprocess protocol useful for repair prompts without echoing a
    # potentially enormous model output.  Pydantic's location/type text is
    # sufficient for the model to repair its own JSON.
    messages: list[str] = []
    for item in error.errors()[:20]:
        location = ".".join(str(part) for part in item.get("loc", ())) or "$"
        message = str(item.get("msg", "validation failed"))[:300]
        messages.append(f"{location}: {message}")
    return "\n".join(messages)[:6000]


def _protocol() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
        value = payload.get("value") if isinstance(payload, dict) and "value" in payload else payload
        result = validate_criteria_document(value)
        print(json.dumps({"ok": True, "result": result.model_dump(mode="json")}, ensure_ascii=False))
        return 0
    except ValidationError as error:
        print(json.dumps({"ok": False, "error": {"code": "CRITERIA_VALIDATION_ERROR", "message": _safe_error(error)}}, ensure_ascii=False))
        return 0
    except Exception as error:  # pragma: no cover - defensive protocol boundary
        print(json.dumps({"ok": False, "error": {"code": "CRITERIA_VALIDATOR_ERROR", "message": str(error)[:1000]}}, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    raise SystemExit(_protocol())
