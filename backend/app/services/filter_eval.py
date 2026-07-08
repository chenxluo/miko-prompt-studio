"""Safe filter-expression evaluator for run-item contexts.

Wraps the ``simpleeval`` library so agents can write dot-notation expressions
such as ``parsed.category == "food"`` against the structured JSON stored on a
``RunItemORM``.  Dicts are recursively converted to ``SimpleNamespace`` objects
so attribute access works naturally, while the evaluator keeps the default safe
operator set (no function calls, no attribute assignment).
"""

from __future__ import annotations

import types
from typing import Any

import simpleeval


class FilterError(Exception):
    """Raised when a filter expression cannot be evaluated."""

    def __init__(self, expr: str, message: str) -> None:
        self.expr = expr
        self.underlying = message
        super().__init__(f"{expr} -> {message}")

    def __str__(self) -> str:
        return self.args[0]


class _NoneProxy:
    """Stand-in for a top-level field whose value is ``None``.

    Accessing any attribute or item on it raises a clear ``AttributeError``
    naming the missing field, which we then convert to a ``FilterError``.
    """

    def __init__(self, name: str) -> None:
        self.name = name

    def __getattr__(self, item: str) -> Any:
        raise AttributeError(
            f"Field '{self.name}' is None while evaluating expression"
        )

    def __getitem__(self, item: Any) -> Any:
        raise AttributeError(
            f"Field '{self.name}' is None while evaluating expression"
        )

    def __bool__(self) -> bool:
        return False

    def __eq__(self, other: object) -> bool:
        return other is None or isinstance(other, _NoneProxy)

    def __ne__(self, other: object) -> bool:
        return not self.__eq__(other)

    def __repr__(self) -> str:
        return f"NoneProxy({self.name!r})"


def _to_ns(obj: Any) -> Any:
    """Recursively convert dicts to attribute-accessible namespaces."""
    if isinstance(obj, dict):
        return types.SimpleNamespace(**{k: _to_ns(v) for k, v in obj.items()})
    if isinstance(obj, list):
        return [_to_ns(v) for v in obj]
    return obj


def build_item_context(run_item: Any) -> dict[str, Any]:
    """Flatten a RunItem ORM object (or namespace stand-in) into a filter context.

    The returned dict contains plain JSON-serializable values:

    - ``sample_id``
    - ``run_item_id``
    - ``status``
    - ``parsed`` (``response.parsed``)
    - ``raw_text`` (``response.raw_text``)
    - ``usage`` (dict)
    - ``cost`` (dict)

    ``apply_filter`` converts these internally to attribute-accessible namespaces
    so expressions like ``parsed.category`` and ``cost.total`` work.
    """
    response = run_item.response or {}
    if not isinstance(response, dict):
        response = {}

    parsed = response.get("parsed")
    raw_text = response.get("raw_text")
    usage = run_item.usage or {}
    cost = run_item.cost or {}

    return {
        "sample_id": run_item.sample_id,
        "run_item_id": run_item.run_item_id,
        "status": run_item.status,
        "parsed": parsed,
        "raw_text": raw_text,
        "usage": usage,
        "cost": cost,
    }


def _eval_names(ctx: dict[str, Any]) -> dict[str, Any]:
    """Prepare a context dict for simpleeval by enabling dot-notation access."""
    names: dict[str, Any] = {}
    for key, value in ctx.items():
        if isinstance(value, dict):
            names[key] = _to_ns(value)
        elif value is None:
            names[key] = _NoneProxy(key)
        else:
            names[key] = value
    return names


def apply_filter(items: list[dict], expr: str) -> list[dict]:
    """Return the subset of ``items`` for which ``expr`` evaluates truthy.

    ``expr`` is a ``simpleeval`` expression using the keys available in each
    item context.  Empty or whitespace-only ``expr`` returns all items.
    """
    if not expr or not expr.strip():
        return items

    out: list[dict] = []
    for item in items:
        # ``simpleeval`` expects a flat mapping of names.  Dict values are
        # wrapped recursively so dot-notation resolves naturally.
        evaluator = simpleeval.EvalWithCompoundTypes(names=_eval_names(item))
        try:
            if evaluator.eval(expr):
                out.append(item)
        except (AttributeError, simpleeval.NameNotDefined) as exc:
            raise FilterError(expr, str(exc)) from exc
        except simpleeval.InvalidExpression as exc:
            raise FilterError(expr, str(exc)) from exc
        except Exception as exc:  # pragma: no cover - defensive fallback
            raise FilterError(expr, str(exc)) from exc
    return out
