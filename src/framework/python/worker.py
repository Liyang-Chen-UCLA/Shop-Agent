from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any, Callable


PROTOCOL_STDOUT = sys.stdout
VALIDATORS = {"criteria_v1": "shop/criteria_contract.py", "market_v1": "shop/market_contract.py"}
tools: dict[str, tuple[Callable[[dict[str, Any], dict[str, Any]], Any], Path]] = {}
validators: dict[str, Callable[[Any, dict[str, Any]], Any]] = {}


class _StderrWriter:
    def write(self, value: str) -> int:
        return sys.stderr.write(value)

    def flush(self) -> None:
        sys.stderr.flush()


def emit(value: dict[str, Any]) -> None:
    PROTOCOL_STDOUT.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    PROTOCOL_STDOUT.flush()


def load_module(entry: Path, label: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(f"shop_agent_worker_{label}", entry)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {label}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    with contextlib.redirect_stdout(_StderrWriter()):
        spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def execution_environment(environment: dict[str, str]):
    original = os.environ.copy()
    original_cwd = Path.cwd()
    try:
        os.environ.clear()
        os.environ.update(original)
        os.environ.update(environment)
        with contextlib.redirect_stdout(_StderrWriter()):
            yield
    finally:
        os.chdir(original_cwd)
        os.environ.clear()
        os.environ.update(original)


def initialize(params: dict[str, Any]) -> dict[str, Any]:
    root = Path(params["projectRoot"]).resolve()
    configured = params.get("tools", [])
    for item in configured:
        name = item["name"]
        module = load_module(Path(item["entry"]).resolve(), f"tool_{name}")
        handler = getattr(module, "handle", None)
        if not callable(handler):
            raise RuntimeError(f"Python tool '{name}' must export handle(arguments, context)")
        tools[name] = (handler, Path(item["entry"]).resolve().parent)
    for validator_id, relative in VALIDATORS.items():
        module = load_module(root / relative, f"validator_{validator_id}")
        handler = getattr(module, "handle", None)
        if not callable(handler):
            raise RuntimeError(f"trusted validator '{validator_id}' must export handle(value, context)")
        validators[validator_id] = handler
    return {"tools": sorted(tools), "validators": sorted(validators)}


def dispatch(method: str, params: dict[str, Any]) -> Any:
    if method == "initialize":
        return initialize(params)
    if method == "health.ping":
        return {"pong": True, "pid": os.getpid()}
    if method == "tool.execute":
        name = params.get("tool")
        if name not in tools:
            raise ValueError(f"Unknown Python tool '{name}'.")
        arguments = params.get("arguments", {})
        context = params.get("context", {})
        if not isinstance(arguments, dict) or not isinstance(context, dict):
            raise ValueError("tool arguments and context must be objects")
        handler, directory = tools[name]
        with execution_environment(params.get("env", {})):
            os.chdir(directory)
            return handler(arguments, context)
    if method == "validator.execute":
        validator_id = params.get("validator")
        if validator_id not in validators:
            raise ValueError(f"Unknown trusted output validator '{validator_id}'.")
        context = params.get("context", {})
        if not isinstance(context, dict):
            raise ValueError("validator context must be an object")
        with execution_environment(params.get("env", {})):
            return validators[validator_id](params.get("value"), context)
    if method == "worker.shutdown":
        return None
    raise ValueError(f"Unknown worker method '{method}'.")


def main() -> int:
    emit({"type": "ready", "protocol": 1})
    for line in sys.stdin:
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            result = dispatch(request.get("method", ""), request.get("params", {}))
            emit({"id": request.get("id"), "ok": True, "result": result})
            if request.get("method") == "worker.shutdown":
                return 0
        except Exception as error:
            emit({"id": request.get("id"), "ok": False, "error": {"code": type(error).__name__.upper(), "message": str(error)[:6000]}})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
