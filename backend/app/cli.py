"""Command-line interface for Miko Prompt Studio.

Exposes the read + run loop (Tier 1 + 2) for external agents and scripts, plus
portable bundle export/import for cross-device migration.
Architecture: in-process — imports the FastAPI route handlers and the batch
executor directly and drives them with a SQLAlchemy session against the same
SQLite database the desktop GUI uses (~/.miko_prompt_studio/miko.db). No server
needs to be running; WAL lets the CLI coexist with an open GUI.

The route handlers are async functions whose only HTTP-ism is the
``db: AsyncSession = Depends(get_db)`` default; passing ``db=`` explicitly
sidesteps the dependency entirely, so the CLI reuses the exact same code path
as the REST API (no logic duplicated, stays in sync).
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import sys
import types
from collections.abc import Callable
from typing import Any

from app.database import init_db, session_scope
from app.services.batch_executor import _running_tasks
from app.services.bundle import (
    ExportOptions,
    ExportScope,
    ImportOptions,
    export_to_file,
    import_bundle,
    read_bundle,
)
from app.services.filter_eval import FilterError, apply_filter, build_item_context
from app.services.refs import (
    RefResolutionError,
    resolve_sset_ref,
    resolve_task_ref,
    resolve_version_ref,
)
from app.services.sample_derive import DeriveError, derive_sample_set_from_run

# Type-only: keep the lint happy about the dict type.
_JSON_MODE = False


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def _want_json(args: argparse.Namespace) -> bool:
    explicit = getattr(args, "json", None)
    if explicit is not None:
        return bool(explicit)
    # Default: JSON when piped, human-readable when interactive.
    return not sys.stdout.isatty()


def _emit(obj: Any, *, human: Callable[[Any], None] | None = None) -> None:
    """Print ``obj`` as JSON or via ``human`` depending on mode."""
    if _JSON_MODE:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    elif human is not None:
        human(obj)
    else:
        # Fallback: human-readable key/value for a single record.
        _human_record(obj)


def _human_record(obj: Any) -> None:
    for key, value in (obj.items() if isinstance(obj, dict) else []):
        if isinstance(value, dict | list):
            print(f"{key}:")
            print(json.dumps(value, ensure_ascii=False, indent=2))
        else:
            print(f"{key}: {value}")


def _table(rows: list[dict], columns: list[tuple[str, str]], *, empty: str = "(none)") -> None:
    """Render a list of dicts as an aligned table.

    ``columns`` is a list of ``(json_key, header)`` pairs.
    """
    if not rows:
        print(empty)
        return
    headers = [h for _, h in columns]
    table = [[_fmt_cell(_dig(row, key)) for key, _ in columns] for row in rows]
    widths = [len(h) for h in headers]
    for cells in table:
        for i, cell in enumerate(cells):
            widths[i] = max(widths[i], len(cell))
    # ponytail: cap column width so a huge prompt/text field can't blow out the layout.
    widths = [min(w, 60) for w in widths]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    print(fmt.format(*headers))
    print(fmt.format(*["-" * w for w in widths]))
    for cells in table:
        print(fmt.format(*[c[: w] for c, w in zip(cells, widths, strict=False)]))


def _dig(row: Any, key: str) -> Any:
    cur: Any = row
    for part in key.split("."):
        cur = cur.get(part) if isinstance(cur, dict) else None
        if cur is None:
            break
    return cur


def _fmt_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _get_path(obj: Any, path: str) -> Any:
    """Descend into a dict/namespace by a dot-separated path.

    Missing path segments return ``None`` rather than raising.
    """
    cur: Any = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, types.SimpleNamespace):
            cur = getattr(cur, part, None)
        else:
            cur = None
        if cur is None:
            break
    return cur


def _print_formatted_items(
    items: list[dict], *, select: list[str] | None, fmt: str | None
) -> None:
    """Render filtered items as JSON, JSONL or CSV."""
    if select:
        out = [{field: _get_path(item, field) for field in select} for item in items]
    else:
        out = items

    if fmt == "jsonl":
        for row in out:
            print(json.dumps(row, ensure_ascii=False))
        return

    if fmt == "csv":
        if not select:
            raise ValueError("--format csv requires --select")
        writer = csv.writer(sys.stdout, lineterminator="\n")
        writer.writerow(select)
        for row in out:
            writer.writerow([_fmt_cell(row.get(field)) for field in select])
        return

    # Default JSON.  Pretty when interactive, compact when piped.
    if sys.stdout.isatty():
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))


# ---------------------------------------------------------------------------
# Human printers
# ---------------------------------------------------------------------------


def _human_task_list(tasks: list[dict]) -> None:
    _table(
        tasks,
        [
            ("task_id", "TASK ID"),
            ("name", "NAME"),
            ("current_version.version_label", "VERSION"),
            ("updated_at", "UPDATED"),
        ],
    )


def _human_sset_list(sets: list[dict]) -> None:
    rows = [
        {
            "sample_set_id": s.get("sample_set_id"),
            "name": s.get("name"),
            "count": len(s.get("record_ids") or []),
            "created_at": s.get("created_at"),
        }
        for s in sets
    ]
    _table(
        rows,
        [
            ("sample_set_id", "SAMPLE SET"),
            ("name", "NAME"),
            ("count", "COUNT"),
            ("created_at", "CREATED"),
        ],
    )


def _human_mconfig_list(configs: list[dict]) -> None:
    _table(
        configs,
        [
            ("model_config_id", "CONFIG ID"),
            ("name", "NAME"),
            ("model_id", "MODEL"),
            ("adapter_id", "ADAPTER"),
        ],
    )


def _human_provider_list(providers: list[dict]) -> None:
    _table(
        providers,
        [
            ("provider_config_id", "CONFIG ID"),
            ("name", "NAME"),
            ("adapter_id", "ADAPTER"),
            ("base_url", "BASE URL"),
        ],
    )



def _human_run_list_compact(payload: dict) -> None:
    rows = payload.get("runs", [])
    if not rows:
        print("(no runs)")
        return
    out_rows = []
    for r in rows:
        summary = r.get("summary") or {}
        out_rows.append(
            {
                "run_id": r.get("run_id"),
                "type": r.get("run_type"),
                "name": r.get("name"),
                "status": r.get("status"),
                "done": f"{summary.get('succeeded_items', 0)}/{summary.get('total_items', 0)}",
                "created": r.get("created_at"),
            }
        )
    _table(
        out_rows,
        [
            ("run_id", "RUN ID"),
            ("type", "TYPE"),
            ("name", "NAME"),
            ("status", "STATUS"),
            ("done", "DONE"),
            ("created", "CREATED"),
        ],
    )


def _human_run_get(payload: dict) -> None:
    session = payload.get("session") or {}
    summary = session.get("summary") or {}
    print(f"run_id:     {session.get('run_id')}")
    print(f"type:       {session.get('run_type')}")
    print(f"name:       {session.get('name')}")
    print(f"status:     {session.get('status')}")
    print(
        "progress:   "
        f"{summary.get('succeeded_items', 0)} ok / "
        f"{summary.get('failed_items', 0)} failed / "
        f"{summary.get('total_items', 0)} total"
    )
    cost = summary.get("total_cost_estimated")
    if cost:
        print(f"cost:       {cost} {summary.get('currency', 'USD')}")
    if session.get("started_at"):
        print(f"started:    {session.get('started_at')}")
    if session.get("completed_at"):
        print(f"completed:  {session.get('completed_at')}")
    items = payload.get("items") or []
    if items:
        print()
        _human_run_items({"items": items})


def _human_run_items(payload: dict) -> None:
    items = payload.get("items") or []
    if not items:
        print("(no items)")
        return
    out_rows = []
    for it in items:
        usage = it.get("usage") or {}
        out_rows.append(
            {
                "run_item_id": it.get("run_item_id"),
                "sample_id": it.get("sample_id"),
                "status": it.get("status"),
                "model": it.get("model_id"),
                "tokens": usage.get("total_tokens", ""),
                "cost": it.get("estimated_cost", ""),
            }
        )
    _table(
        out_rows,
        [
            ("run_item_id", "ITEM ID"),
            ("sample_id", "SAMPLE"),
            ("status", "STATUS"),
            ("model", "MODEL"),
            ("tokens", "TOKENS"),
            ("cost", "COST"),
        ],
    )


def _human_run_summary(payload: dict) -> None:
    """One-block summary used after a blocking `task run`."""
    summary = payload.get("summary") or {}
    print(f"run_id:   {payload.get('run_id')}")
    print(f"status:   {payload.get('status')}")
    print(
        "done:     "
        f"{summary.get('succeeded_items', 0)} ok / "
        f"{summary.get('failed_items', 0)} failed / "
        f"{summary.get('total_items', 0)} total"
    )
    cost = summary.get("total_cost_estimated")
    if cost:
        print(f"cost:     {cost} {summary.get('currency', 'USD')}")
# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


async def cmd_task_list(args: argparse.Namespace) -> None:
    from app.main import list_tasks

    async with session_scope() as db:
        tasks = await list_tasks(group_id=args.group, db=db)
    _emit(tasks, human=_human_task_list)


async def cmd_task_get(args: argparse.Namespace) -> None:
    from app.main import get_task

    async with session_scope() as db:
        task, _ = await resolve_task_ref(db, args.task_id)
        task = await get_task(task.task_id, db=db)
    _emit(task)


async def cmd_task_run(args: argparse.Namespace) -> None:
    from app.main import BatchRunPayload, _batch_status_response, create_batch_run

    # Resolve task/sample-set (and optional version) before building the payload.
    async with session_scope() as db:
        task, version = await resolve_task_ref(db, args.task_id)
        if args.version:
            _, version = await resolve_version_ref(db, args.task_id, args.version)
        sset = await resolve_sset_ref(db, args.sample_set)
        payload = BatchRunPayload(
            task_id=task.task_id,
            sample_set_id=sset.sample_set_id,
            task_version_id=version.task_version_id,
            limit=args.limit,
            limit_strategy=args.limit_strategy,
            max_concurrency=args.concurrency,
            max_retries=args.retries,
            pipeline_id=args.pipeline_id,
            pipeline_step=args.pipeline_step,
        )

        # `create_batch_run` starts a fire-and-forget background worker and returns
        # the early (running) status. The worker lives in *this* event loop, so if
        # the process exits now the loop closes and the run is killed. In-process
        # CLI therefore MUST await the worker to completion before returning.
        early = await create_batch_run(payload, db=db)
        run_id = early.get("run_id")
    if not run_id:
        raise RuntimeError("Batch run did not return a run_id.")

    # Emit run_id to stderr immediately so an agent whose shell times out
    # mid-run still has the run_id to poll later. Stdout is reserved for the
    # final summary JSON, so this must never go there.
    if _want_json(args):
        print(
            json.dumps({"event": "started", "run_id": run_id}, ensure_ascii=False),
            file=sys.stderr,
        )
    else:
        print(
            f"run_id: {run_id} (running, will block until done...)",
            file=sys.stderr,
        )
    sys.stderr.flush()

    worker = _running_tasks.get(run_id)
    if worker is not None:
        await worker  # blocks until the batch finishes (or fails/cancels)

    async with session_scope() as db:
        final = await _batch_status_response(run_id, db=db)
    _emit(final, human=_human_run_summary)


async def cmd_run_list(args: argparse.Namespace) -> None:
    from app.main import list_runs

    async with session_scope() as db:
        result = await list_runs(
            run_type=args.type,
            status=args.status,
            search=args.search,
            limit=args.limit,
            offset=args.offset,
            db=db,
        )
    _emit(result, human=_human_run_list_compact)


async def cmd_run_get(args: argparse.Namespace) -> None:
    from app.main import get_run

    async with session_scope() as db:
        result = await get_run(args.run_id, db=db)
    _emit(result, human=_human_run_get)


async def cmd_run_items(args: argparse.Namespace) -> None:
    from app.main import get_run

    async with session_scope() as db:
        result = await get_run(args.run_id, db=db)
    items = result.get("items", [])

    if not args.select and not args.filter and args.format is None:
        _emit({"items": items}, human=_human_run_items)
        return

    contexts = [build_item_context(types.SimpleNamespace(**item)) for item in items]
    if args.filter:
        contexts = apply_filter(contexts, args.filter)

    select = [f.strip() for f in args.select.split(",") if f.strip()] if args.select else None
    fmt = args.format
    if fmt is None:
        fmt = "jsonl" if not sys.stdout.isatty() else "json"
    if fmt == "csv" and not select:
        raise ValueError("--format csv requires --select")
    _print_formatted_items(contexts, select=select, fmt=fmt)


async def cmd_run_cancel(args: argparse.Namespace) -> None:
    from app.main import cancel_batch_run

    async with session_scope() as db:
        result = await cancel_batch_run(args.run_id, db=db)
    _emit(result)


async def cmd_run_export(args: argparse.Namespace) -> None:
    from app.main import export_run_csv, export_run_html, export_run_jsonl

    async with session_scope() as db:
        if args.format == "jsonl":
            resp = await export_run_jsonl(args.run_id, db=db)
        elif args.format == "csv":
            resp = await export_run_csv(args.run_id, db=db)
        else:
            resp = await export_run_html(args.run_id, db=db)

    body = resp.body
    if args.out:
        with open(args.out, "wb") as fh:
            fh.write(body)
        print(f"Wrote {len(body)} bytes to {args.out}")
    else:
        # Binary-safe stdout so HTML/CSV bytes survive Windows encodings.
        sys.stdout.buffer.write(body)
        if not body.endswith(b"\n"):
            sys.stdout.buffer.write(b"\n")


async def cmd_sset_list(args: argparse.Namespace) -> None:
    from app.main import list_sample_sets

    async with session_scope() as db:
        sets = await list_sample_sets(db=db)
    _emit(sets, human=_human_sset_list)


async def cmd_sset_get(args: argparse.Namespace) -> None:
    from app.main import get_sample_set

    async with session_scope() as db:
        sset = await resolve_sset_ref(db, args.sample_set_id)
        sset = await get_sample_set(sset.sample_set_id, db=db)
    _emit(sset)


async def cmd_sset_from_run(args: argparse.Namespace) -> None:
    if args.drop_original and not args.carry_response:
        print(
            "warning: --drop-original without --carry-response produces "
            "records with empty vars/images.",
            file=sys.stderr,
        )
    async with session_scope() as db:
        task_version_id = None
        if args.task_version:
            _, version = await resolve_version_ref(db, None, args.task_version)
            task_version_id = version.task_version_id

        sset = await derive_sample_set_from_run(
            db,
            args.run_id,
            name=args.name,
            filter_expr=args.filter,
            carry_response=args.carry_response,
            drop_original=args.drop_original,
            task_version_id=task_version_id,
        )
    _emit(
        {
            "sample_set_id": sset.sample_set_id,
            "name": sset.name,
            "record_count": len(sset.record_ids or []),
        }
    )


async def cmd_provider_list(args: argparse.Namespace) -> None:
    from app.main import list_provider_configs

    async with session_scope() as db:
        providers = await list_provider_configs(db=db)
    _emit(providers, human=_human_provider_list)


async def cmd_provider_models(args: argparse.Namespace) -> None:
    from app.main import FetchModelsPayload, fetch_provider_models

    payload = FetchModelsPayload(
        provider_config_id=args.provider_config_id,
        api_key=args.api_key,
        base_url=args.base_url,
    )
    async with session_scope() as db:
        result = await fetch_provider_models(payload, db=db)
    _emit(result)


async def cmd_mconfig_list(args: argparse.Namespace) -> None:
    from app.main import list_model_configs

    async with session_scope() as db:
        configs = await list_model_configs(db=db)
    _emit(configs, human=_human_mconfig_list)


# ---------------------------------------------------------------------------
# Tier 3: task editing, import, compare, raw API
# ---------------------------------------------------------------------------

_VERSION_FIELDS = [
    "system_prompt",
    "user_template",
    "provider_config_id",
    "model_id",
    "model_parameters",
    "output_contract",
    "image_preprocess_config",
    "image_slot_specs",
    "variable_specs",
    "pricing_profile_id",
    "notes",
]


def _split_tags(value: str | None) -> list[str]:
    if not value:
        return []
    return [t.strip() for t in value.split(",") if t.strip()]


def _text_arg(args: argparse.Namespace, inline: str, file_attr: str) -> str | None:
    """Resolve a text value from an --inline flag or a --*-file flag."""
    value = getattr(args, inline, None)
    if value is not None:
        return value
    path = getattr(args, file_attr, None)
    if path:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    return None


def _deep_merge(base: dict, overlay: dict) -> dict:
    """Recursively merge ``overlay`` into ``base``; nested dicts merge, lists replace."""
    out = dict(base)
    for key, val in overlay.items():
        if key in out and isinstance(out[key], dict) and isinstance(val, dict):
            out[key] = _deep_merge(out[key], val)
        else:
            out[key] = val
    return out


def _param_overrides(args: argparse.Namespace) -> dict:
    """ModelParameters field overrides derived from scalar flags."""
    overrides: dict = {}
    if getattr(args, "temperature", None) is not None:
        overrides["temperature"] = args.temperature
    if getattr(args, "max_tokens", None) is not None:
        overrides["max_output_tokens"] = args.max_tokens
    thinking = getattr(args, "thinking", None)
    if thinking is not None:
        overrides["enable_thinking"] = {"on": True, "off": False, "default": None}[thinking]
    if getattr(args, "thinking_budget", None) is not None:
        overrides["thinking_budget"] = args.thinking_budget
    effort = getattr(args, "reasoning_effort", None)
    if effort is not None:
        overrides["reasoning_effort"] = effort
    return overrides


def _version_overlay(args: argparse.Namespace) -> dict:
    """Build a partial TaskVersionData dict from scalar flags + ``--from-file``.

    Flags take precedence over the file (more specific intent wins). Nested
    dicts (model_parameters, output_contract, image_preprocess_config) merge
    deeply; lists (image_slot_specs, variable_specs) replace wholesale.
    """
    overlay: dict = {}
    sp = _text_arg(args, "system_prompt", "system_prompt_file")
    if sp is not None:
        overlay["system_prompt"] = sp
    ut = _text_arg(args, "user_template", "user_template_file")
    if ut is not None:
        overlay["user_template"] = ut
    if getattr(args, "model", None) is not None:
        overlay["model_id"] = args.model
    if getattr(args, "provider_config", None) is not None:
        overlay["provider_config_id"] = args.provider_config
    if getattr(args, "pricing_profile", None) is not None:
        overlay["pricing_profile_id"] = args.pricing_profile
    if getattr(args, "notes", None) is not None:
        overlay["notes"] = args.notes
    param_overrides = _param_overrides(args)
    if param_overrides:
        overlay["model_parameters"] = param_overrides
    if getattr(args, "from_file", None):
        with open(args.from_file, encoding="utf-8") as fh:
            file_overlay = json.load(fh)
        overlay = _deep_merge(file_overlay, overlay)
    return overlay


def _compose_version(base: dict, overlay: dict) -> dict:
    """Deep-merge overlay onto base, keep only TaskVersionData fields."""
    merged = _deep_merge(base, overlay)
    return {k: merged[k] for k in _VERSION_FIELDS if k in merged and merged[k] is not None}


async def cmd_task_spec(args: argparse.Namespace) -> None:
    from app.main import get_task_input_spec

    async with session_scope() as db:
        task, version = await resolve_task_ref(db, args.task_id)
        if args.version:
            _, version = await resolve_version_ref(db, args.task_id, args.version)
        spec = await get_task_input_spec(task.task_id, version.task_version_id, db=db)
    _emit(spec, human=_human_task_spec)


async def cmd_task_new(args: argparse.Namespace) -> None:
    from app.main import CreateTaskPayload, create_task
    from app.schemas.task import TaskVersionData

    overlay = _version_overlay(args)
    if not overlay.get("model_id"):
        raise ValueError("A model_id is required (--model or --from-file).")
    version = TaskVersionData(**_compose_version({}, overlay))
    payload = CreateTaskPayload(
        name=args.name,
        description=args.description,
        tags=_split_tags(args.tags),
        group_id=args.group,
        version=version,
    )
    async with session_scope() as db:
        task = await create_task(payload, db=db)
    _emit(task, human=_human_task_brief)


async def cmd_task_edit(args: argparse.Namespace) -> None:
    from app.main import CreateTaskVersionPayload, create_task_version, get_task

    overlay = _version_overlay(args)
    if not overlay:
        raise ValueError("No changes given (pass version flags or --from-file).")
    async with session_scope() as db:
        task, _ = await resolve_task_ref(db, args.task_id)
        task_dict = await get_task(task.task_id, db=db)
        current = task_dict.get("current_version")
        if current is None:
            raise ValueError("Task has no current version to edit.")
        base = {k: current.get(k) for k in _VERSION_FIELDS}
        payload = CreateTaskVersionPayload(**_compose_version(base, overlay))
        new_version = await create_task_version(task.task_id, payload, db=db)
    _emit(new_version, human=_human_task_brief)


async def cmd_task_set_header(args: argparse.Namespace) -> None:
    from app.main import UpdateTaskPayload, update_task

    payload = UpdateTaskPayload(
        name=args.name,
        description=args.description,
        tags=_split_tags(args.tags) if args.tags is not None else None,
        group_id=args.group,
    )
    if all(v is None for v in (payload.name, payload.description, payload.tags, payload.group_id)):
        raise ValueError("No header changes given (--name/--description/--tags/--group).")
    async with session_scope() as db:
        task, _ = await resolve_task_ref(db, args.task_id)
        task = await update_task(task.task_id, payload, db=db)
    _emit(task, human=_human_task_brief)


async def cmd_task_fork(args: argparse.Namespace) -> None:
    from app.main import ForkTaskPayload, fork_task

    async with session_scope() as db:
        task, version = await resolve_task_ref(db, args.task_id)
        if args.version:
            _, version = await resolve_version_ref(db, args.task_id, args.version)
        payload = ForkTaskPayload(
            source_version_id=version.task_version_id,
            name=args.name,
            description=args.description,
            tags=_split_tags(args.tags),
        )
        task = await fork_task(task.task_id, payload, db=db)
    _emit(task, human=_human_task_brief)


async def cmd_task_rm(args: argparse.Namespace) -> None:
    from app.main import delete_task

    async with session_scope() as db:
        task, _ = await resolve_task_ref(db, args.task_id)
        result = await delete_task(task.task_id, db=db)
    _emit(result)


async def cmd_task_rm_version(args: argparse.Namespace) -> None:
    from app.main import delete_task_version

    async with session_scope() as db:
        task, version = await resolve_version_ref(db, args.task_id, args.version_id)
        result = await delete_task_version(task.task_id, version.task_version_id, db=db)
    _emit(result)


async def cmd_sset_import_csv(args: argparse.Namespace) -> None:
    from app.main import (
        _persist_sample_records,
        _task_version_schema_by_id,
        _validation_report_for_records,
    )
    from app.services.importer import (
        ColumnMapping,
        detect_columns,
        import_csv,
        suggest_column_mapping,
    )

    version_id = None
    if args.mapping_file:
        with open(args.mapping_file, encoding="utf-8") as fh:
            mapping = ColumnMapping.model_validate(json.load(fh))
    else:
        columns = detect_columns(args.path, delimiter=args.delimiter)
        image_specs = variable_specs = None
        if args.task_version:
            async with session_scope() as db:
                _, version = await resolve_version_ref(db, None, args.task_version)
                tv = await _task_version_schema_by_id(version.task_version_id, db)
            image_specs, variable_specs = tv.image_slot_specs, tv.variable_specs
            version_id = version.task_version_id
        mapping = suggest_column_mapping(columns, image_specs, variable_specs)
        mapping.base_dir = args.base_dir
        if version_id:
            mapping.task_version_id = version_id

    records = import_csv(args.path, mapping, delimiter=args.delimiter)
    if not records:
        raise ValueError("No rows imported (check id_column / mapping).")

    async with session_scope() as db:
        report = await _validation_report_for_records(records, version_id, db)
        if args.validate_only:
            if report is not None:
                _emit(report.model_dump(mode="json"))
            else:
                _emit({"valid_count": len(records)})
            return
        sample_set_id = await _persist_sample_records(
            db,
            records,
            name=args.name or f"Import {os.path.basename(args.path)}",
            import_source={"type": "csv", "path": args.path},
        )
    _emit(
        {
            "sample_set_id": sample_set_id,
            "imported_count": len(records),
            **({"validation": report.model_dump(mode="json")} if report is not None else {}),
        },
        human=_human_sset_import,
    )


async def cmd_sset_import_jsonl(args: argparse.Namespace) -> None:
    from app.main import (
        _persist_sample_records,
        _validation_report_for_records,
    )
    from app.services.importer import import_jsonl

    version_id = None
    if args.task_version:
        async with session_scope() as db:
            _, version = await resolve_version_ref(db, None, args.task_version)
        version_id = version.task_version_id

    try:
        records = import_jsonl(args.path)
    except ValueError as exc:
        raise ValueError(f"JSONL import failed: {exc}") from exc
    if not records:
        raise ValueError("No records imported.")

    async with session_scope() as db:
        report = await _validation_report_for_records(records, version_id, db)
        if args.validate_only:
            if report is not None:
                _emit(report.model_dump(mode="json"))
            else:
                _emit({"valid_count": len(records)})
            return
        sample_set_id = await _persist_sample_records(
            db,
            records,
            name=args.name or f"Import {os.path.basename(args.path)}",
            import_source={"type": "jsonl", "path": args.path},
        )
    _emit(
        {
            "sample_set_id": sample_set_id,
            "imported_count": len(records),
            **({"validation": report.model_dump(mode="json")} if report is not None else {}),
        },
        human=_human_sset_import,
    )


async def cmd_sset_rm(args: argparse.Namespace) -> None:
    from app.main import delete_sample_set

    async with session_scope() as db:
        sset = await resolve_sset_ref(db, args.sample_set_id)
        result = await delete_sample_set(sset.sample_set_id, db=db)
    _emit(result)


async def cmd_compare_run(args: argparse.Namespace) -> None:
    from app.main import (
        CompareRunPayload,
        CompareVariant,
        _compare_status_response,
        create_compare_run,
    )
    from app.services.compare_executor import _running_tasks as _compare_running

    async with session_scope() as db:
        sset = await resolve_sset_ref(db, args.sample_set)
        variants = []
        for v in args.variant:
            task, version = await resolve_task_ref(db, v)
            variants.append(
                CompareVariant(
                    task_id=task.task_id,
                    task_version_id=version.task_version_id,
                )
            )
        payload = CompareRunPayload(
            sample_set_id=sset.sample_set_id,
            variants=variants,
            limit=args.limit,
            name=args.name,
        )
        # Same fire-and-forget + await-worker pattern as `task run`: the compare
        # worker lives in this loop, so the CLI must block on it before exiting.
        early = await create_compare_run(payload, db=db)
        run_id = early.get("run_id")
    if not run_id:
        raise RuntimeError("Compare run did not return a run_id.")
    worker = _compare_running.get(run_id)
    if worker is not None:
        await worker
    async with session_scope() as db:
        final = await _compare_status_response(run_id, db=db)
    _emit(final, human=_human_run_summary)


async def cmd_api(args: argparse.Namespace) -> None:
    import httpx

    from app.main import app

    body = None
    if args.data is not None:
        body = json.loads(args.data)
    elif args.data_file is not None:
        with open(args.data_file, encoding="utf-8") as fh:
            body = json.load(fh)

    # In-process ASGI call: the full HTTP API without a port. Covers every
    # endpoint not wrapped by a dedicated subcommand.
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://mps") as client:
        resp = await client.request(args.method, args.path, json=body)

    if _JSON_MODE:
        try:
            parsed = resp.json()
        except ValueError:
            parsed = resp.text
        payload = {"status": resp.status_code, "body": parsed}
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"HTTP {resp.status_code}")
        if resp.text:
            print(resp.text)


# ---------------------------------------------------------------------------
# Export / import (portable bundles)
# ---------------------------------------------------------------------------


async def cmd_export(args: argparse.Namespace) -> None:
    if not args.all_ and not any(
        (args.task, args.sample_set, args.prompt, args.provider)
    ):
        raise ValueError(
            "no export scope given; use --task/--sample-set/--prompt/--provider or --all"
        )

    async with session_scope() as db:
        if args.all_:
            scope = ExportScope(all_=True)
        else:
            task_ids: list[str] = []
            for ref in args.task:
                task, _ = await resolve_task_ref(db, ref)
                task_ids.append(task.task_id)
            sample_set_ids: list[str] = []
            for ref in args.sample_set:
                sset = await resolve_sset_ref(db, ref)
                sample_set_ids.append(sset.sample_set_id)
            scope = ExportScope(
                task_ids=task_ids,
                sample_set_ids=sample_set_ids,
                prompt_ids=args.prompt,
                provider_config_ids=args.provider,
            )
        options = ExportOptions(include_assets=not args.no_assets)
        summary = await export_to_file(db, scope, options, args.out)
    _emit(summary, human=_human_export)


async def cmd_import(args: argparse.Namespace) -> None:
    envelope = read_bundle(args.path)
    async with session_scope() as db:
        options = ImportOptions(
            mode=args.mode,
            dry_run=args.dry_run,
            include_assets=not args.no_assets,
        )
        report = await import_bundle(db, envelope, options)

    report_dict = {
        "created": report.created,
        "updated": report.updated,
        "skipped": report.skipped,
        "duplicated": report.duplicated,
        "renamed": [[kind_id, new_name] for kind_id, new_name in report.renamed],
        "conflicts": report.conflicts,
        "warnings": report.warnings,
        "redactions_needed": report.redactions_needed,
        "dry_run": options.dry_run,
    }
    _emit(report_dict, human=_human_import)


# ---------------------------------------------------------------------------
# Tier 3 human printers
# ---------------------------------------------------------------------------


def _human_task_brief(task: dict) -> None:
    print(f"task_id:           {task.get('task_id')}")
    print(f"name:              {task.get('name')}")
    cv = task.get("current_version") or {}
    print(f"current_version:   {cv.get('version_label')}  ({cv.get('task_version_id')})")
    if cv.get("model_id"):
        print(f"model:             {cv.get('model_id')}")


def _human_sset_import(result: dict) -> None:
    print(f"sample_set_id: {result.get('sample_set_id')}")
    print(f"imported:      {result.get('imported_count')}")
    v = result.get("validation")
    if v:
        print(f"valid:         {v.get('valid_count')}")
        invalid = v.get("invalid_rows") or []
        if invalid:
            print(f"invalid rows:  {len(invalid)} (use --json to see them)")


def _human_export(s: dict) -> None:
    print(f"wrote:    {s.get('path')}")
    print(f"entities: {s.get('entities')}")
    print(f"assets:   {s.get('assets')}")
    print(f"bytes:    {s.get('bytes')}")


def _human_import(r: dict) -> None:
    if r.get("dry_run"):
        print("(dry run — no changes applied)")
    print(f"created:    {len(r.get('created', []))}")
    print(f"updated:    {len(r.get('updated', []))}")
    print(f"skipped:    {len(r.get('skipped', []))}")
    print(f"duplicated: {len(r.get('duplicated', []))}")
    renamed = r.get("renamed") or []
    if renamed:
        print("renamed:")
        for item in renamed:
            print(f"  {item[0]}  ->  {item[1]}")
    warnings = r.get("warnings") or []
    if warnings:
        print("warnings:")
        for w in warnings:
            print(f"  - {w}")
    redactions = r.get("redactions_needed") or []
    if redactions:
        print("redactions needed (reconfigure on this machine):")
        for item in redactions:
            print(f"  - {item}")


def _human_task_spec(spec: dict) -> None:
    print(f"task:    {spec.get('task_name')}  [{spec.get('version_label')}]")
    if spec.get("notes"):
        print(f"notes:   {spec['notes']}")
    print("\nsystem_prompt:")
    print(spec.get("system_prompt") or "(none)")
    print("\nuser_template:")
    print(spec.get("user_template") or "(none)")

    slots = spec.get("image_slots") or []
    if slots:
        print("\nIMAGE SLOTS:")
        _table(
            slots,
            [
                ("slot_id", "SLOT"),
                ("role_hint", "ROLE"),
                ("required", "REQ"),
                ("min_count", "MIN"),
                ("max_count", "MAX"),
                ("description", "DESC"),
            ],
        )
    vslots = spec.get("variable_slots") or []
    if vslots:
        print("\nVARIABLES:")
        _table(
            vslots,
            [
                ("var_id", "VAR"),
                ("type", "TYPE"),
                ("required", "REQ"),
                ("default_value", "DEFAULT"),
                ("description", "DESC"),
            ],
        )
    cols = spec.get("expected_csv_columns") or []
    if cols:
        print("\nEXPECTED CSV COLUMNS:")
        _table(
            cols,
            [
                ("column", "COLUMN"),
                ("kind", "KIND"),
                ("role_hint", "ROLE"),
                ("var_id", "VAR"),
                ("required", "REQ"),
            ],
        )
    if spec.get("csv_example_row"):
        print("\nCSV EXAMPLE ROW:")
        print(json.dumps(spec["csv_example_row"], ensure_ascii=False, indent=2))
    if spec.get("jsonl_example"):
        print("\nJSONL EXAMPLE:")
        print(json.dumps(spec["jsonl_example"], ensure_ascii=False, indent=2))

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def _add_version_flags(p: argparse.ArgumentParser) -> None:
    """Common TaskVersionData scalar flags shared by `task new` / `task edit`."""
    p.add_argument("--model", default=None, help="Model id.")
    p.add_argument("--provider-config", dest="provider_config", default=None)
    p.add_argument("--temperature", type=float, default=None)
    p.add_argument("--max-tokens", dest="max_tokens", type=int, default=None)
    p.add_argument("--thinking", choices=["on", "off", "default"], default=None)
    p.add_argument("--thinking-budget", dest="thinking_budget", type=int, default=None)
    p.add_argument(
        "--reasoning-effort",
        dest="reasoning_effort",
        choices=["minimal", "low", "medium", "high"],
        default=None,
    )
    p.add_argument("--system-prompt", dest="system_prompt", default=None)
    p.add_argument("--system-prompt-file", dest="system_prompt_file", default=None)
    p.add_argument("--user-template", dest="user_template", default=None)
    p.add_argument("--user-template-file", dest="user_template_file", default=None)
    p.add_argument("--notes", default=None)
    p.add_argument("--pricing-profile", dest="pricing_profile", default=None)
    p.add_argument(
        "--from-file",
        dest="from_file",
        default=None,
        help="JSON overlay of TaskVersionData fields (nested dicts merge, lists replace).",
    )


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="mps",
        description="Miko Prompt Studio CLI — run tasks & inspect results (in-process).",
    )
    p.add_argument(
        "--json",
        dest="json",
        action="store_true",
        default=None,
        help="Force JSON output (default when piped).",
    )
    p.add_argument(
        "--no-json",
        dest="json",
        action="store_false",
        default=None,
        help="Force human-readable output (default in a terminal).",
    )

    sub = p.add_subparsers(dest="command", required=True)

    # --- task ---
    task = sub.add_parser("task", help="Tasks and task versions.").add_subparsers(
        dest="subcommand", required=True
    )

    t_list = task.add_parser("list", help="List tasks.")
    t_list.add_argument("--group", default=None, help="Filter by task group id.")
    t_list.set_defaults(_handler=cmd_task_list)

    t_get = task.add_parser("get", help="Show one task with its versions.")
    t_get.add_argument("task_id")
    t_get.set_defaults(_handler=cmd_task_get)

    t_run = task.add_parser(
        "run", help="Run a task version against a sample set (blocks until done)."
    )
    t_run.add_argument("task_id", help="Task id (uses its current version unless --version).")
    t_run.add_argument("--version", default=None, help="Specific task_version_id.")
    t_run.add_argument("--sample-set", required=True, help="Sample set id to run against.")
    t_run.add_argument("--limit", type=int, default=None, help="Cap number of samples.")
    t_run.add_argument(
        "--limit-strategy",
        dest="limit_strategy",
        choices=["first", "random"],
        default="first",
        help="How to pick samples when --limit is set (default: first).",
    )
    t_run.add_argument("--concurrency", type=int, default=1, help="Max concurrent requests.")
    t_run.add_argument("--retries", type=int, default=0, help="Retries on transient errors.")
    t_run.add_argument(
        "--pipeline-id", dest="pipeline_id", default=None,
        help="Pipeline grouping key for chained runs.",
    )
    t_run.add_argument(
        "--pipeline-step", dest="pipeline_step", default=None,
        help="Semantic label for this run's role in the pipeline.",
    )
    t_run.set_defaults(_handler=cmd_task_run)

    t_spec = task.add_parser(
        "spec", help="Input spec for a task version (image/var slots, CSV/JSONL format)."
    )
    t_spec.add_argument("task_id")
    t_spec.add_argument("--version", default=None, help="task_version_id (default: current).")
    t_spec.set_defaults(_handler=cmd_task_spec)

    t_new = task.add_parser("new", help="Create a task with a v1 version.")
    t_new.add_argument("--name", required=True)
    t_new.add_argument("--description", default="")
    t_new.add_argument("--tags", default=None, help="Comma-separated.")
    t_new.add_argument("--group", default=None)
    _add_version_flags(t_new)
    t_new.set_defaults(_handler=cmd_task_new)

    t_edit = task.add_parser(
        "edit",
        help="Edit the current version. Creates a NEW version (history is immutable).",
    )
    t_edit.add_argument("task_id")
    _add_version_flags(t_edit)
    t_edit.set_defaults(_handler=cmd_task_edit)

    t_hdr = task.add_parser(
        "set-header", help="Update task header (name/description/tags/group); no new version."
    )
    t_hdr.add_argument("task_id")
    t_hdr.add_argument("--name", default=None)
    t_hdr.add_argument("--description", default=None)
    t_hdr.add_argument("--tags", default=None, help="Comma-separated.")
    t_hdr.add_argument("--group", default=None)
    t_hdr.set_defaults(_handler=cmd_task_set_header)

    t_fork = task.add_parser("fork", help="Fork a task version into a new independent task.")
    t_fork.add_argument("task_id")
    t_fork.add_argument("--name", required=True)
    t_fork.add_argument("--description", default="")
    t_fork.add_argument("--tags", default=None, help="Comma-separated.")
    t_fork.add_argument(
        "--version", default=None, help="Source task_version_id (default: current)."
    )
    t_fork.set_defaults(_handler=cmd_task_fork)

    t_rm = task.add_parser("rm", help="Delete a task and all its versions.")
    t_rm.add_argument("task_id")
    t_rm.set_defaults(_handler=cmd_task_rm)

    t_rmv = task.add_parser("rm-version", help="Delete one task version.")
    t_rmv.add_argument("task_id")
    t_rmv.add_argument("version_id")
    t_rmv.set_defaults(_handler=cmd_task_rm_version)

    # --- run ---
    run = sub.add_parser("run", help="Inspect / export runs.").add_subparsers(
        dest="subcommand", required=True
    )

    r_list = run.add_parser("list", help="List runs.")
    r_list.add_argument("--type", default=None, help="batch | lab | compare.")
    r_list.add_argument("--status", default=None, help="Filter by status.")
    r_list.add_argument("--search", default=None, help="Substring on run id/name.")
    r_list.add_argument("--limit", type=int, default=50)
    r_list.add_argument("--offset", type=int, default=0)
    r_list.set_defaults(_handler=cmd_run_list)

    r_get = run.add_parser("get", help="Show a run session + its items.")
    r_get.add_argument("run_id")
    r_get.set_defaults(_handler=cmd_run_get)

    r_items = run.add_parser("items", help="List a run's items (one row per sample).")
    r_items.add_argument("run_id")
    r_items.add_argument(
        "--select",
        default=None,
        help="Comma-separated field paths (e.g. sample_id,parsed.category).",
    )
    r_items.add_argument("--filter", default=None, help="Filter expression evaluated per item.")
    r_items.add_argument(
        "--format", choices=["json", "jsonl", "csv"], default=None, help="Output format."
    )
    r_items.set_defaults(_handler=cmd_run_items)

    r_cancel = run.add_parser("cancel", help="Request cancellation of a running batch run.")
    r_cancel.add_argument("run_id")
    r_cancel.set_defaults(_handler=cmd_run_cancel)

    r_export = run.add_parser("export", help="Export a run to jsonl / csv / html.")
    r_export.add_argument("run_id")
    r_export.add_argument(
        "--format", choices=["jsonl", "csv", "html"], default="jsonl"
    )
    r_export.add_argument("--out", default=None, help="Write to file instead of stdout.")
    r_export.set_defaults(_handler=cmd_run_export)

    # --- sset (sample-set) ---
    sset = sub.add_parser("sset", help="Sample sets.").add_subparsers(
        dest="subcommand", required=True
    )
    s_list = sset.add_parser("list", help="List sample sets.")
    s_list.set_defaults(_handler=cmd_sset_list)
    s_get = sset.add_parser("get", help="Show one sample set.")
    s_get.add_argument("sample_set_id")
    s_get.set_defaults(_handler=cmd_sset_get)

    s_from = sset.add_parser(
        "from-run", help="Derive a sample set from a finished run (routing / composition)."
    )
    s_from.add_argument("--run-id", required=True, help="Run id (run_...).")
    s_from.add_argument("--name", required=True, help="Name for the new sample set.")
    s_from.add_argument("--filter", default=None, help="Filter expression for run items.")
    s_from.add_argument(
        "--carry-response",
        dest="carry_response",
        nargs="?",
        const="prev_output",
        default=None,
        help="Carry the upstream response as a variable (default name: prev_output).",
    )
    s_from.add_argument(
        "--drop-original",
        dest="drop_original",
        action="store_true",
        help="Discard original sample vars/images.",
    )
    s_from.add_argument(
        "--task-version",
        dest="task_version",
        default=None,
        help="Optional target task version tag.",
    )
    s_from.set_defaults(_handler=cmd_sset_from_run)

    s_csv = sset.add_parser(
        "import-csv", help="Import CSV/TSV into a sample set (auto-suggests column mapping)."
    )
    s_csv.add_argument("path", help="CSV file path.")
    s_csv.add_argument(
        "--task-version",
        dest="task_version",
        default=None,
        help="task_version_id for contract-aware mapping + validation.",
    )
    s_csv.add_argument("--name", default=None, help="Sample set name.")
    s_csv.add_argument("--delimiter", default=",")
    s_csv.add_argument(
        "--base-dir", dest="base_dir", default=None, help="Prefix for relative image paths."
    )
    s_csv.add_argument(
        "--mapping-file",
        dest="mapping_file",
        default=None,
        help="Full ColumnMapping JSON (overrides auto-suggest).",
    )
    s_csv.add_argument("--validate-only", dest="validate_only", action="store_true")
    s_csv.set_defaults(_handler=cmd_sset_import_csv)

    s_jsonl = sset.add_parser("import-jsonl", help="Import a JSONL file into a sample set.")
    s_jsonl.add_argument("path")
    s_jsonl.add_argument("--task-version", dest="task_version", default=None)
    s_jsonl.add_argument("--name", default=None)
    s_jsonl.add_argument("--validate-only", dest="validate_only", action="store_true")
    s_jsonl.set_defaults(_handler=cmd_sset_import_jsonl)

    s_rm = sset.add_parser("rm", help="Delete a sample set and its samples.")
    s_rm.add_argument("sample_set_id")
    s_rm.set_defaults(_handler=cmd_sset_rm)

    # --- provider ---
    prov = sub.add_parser("provider", help="Provider configs & live models.").add_subparsers(
        dest="subcommand", required=True
    )
    p_list = prov.add_parser("list", help="List provider configs.")
    p_list.set_defaults(_handler=cmd_provider_list)
    p_models = prov.add_parser("models", help="Fetch live model list from a provider.")
    p_models.add_argument("provider_config_id")
    p_models.add_argument("--api-key", default=None, help="Override stored api key.")
    p_models.add_argument("--base-url", default=None, help="Override stored base url.")
    p_models.set_defaults(_handler=cmd_provider_models)

    # --- mconfig ---
    mc = sub.add_parser("mconfig", help="Saved model configs.").add_subparsers(
        dest="subcommand", required=True
    )
    mc_list = mc.add_parser("list", help="List model configs.")
    mc_list.set_defaults(_handler=cmd_mconfig_list)

    # --- compare ---
    cmp = sub.add_parser(
        "compare", help="Compare task variants on one sample set."
    ).add_subparsers(dest="subcommand", required=True)
    c_run = cmp.add_parser(
        "run", help="Run multiple task variants over one sample set (blocks until done)."
    )
    c_run.add_argument("--sample-set", dest="sample_set", required=True)
    c_run.add_argument(
        "--variant",
        action="append",
        required=True,
        help="Task id (uses its current version). Repeatable.",
    )
    c_run.add_argument("--limit", type=int, default=None)
    c_run.add_argument("--name", default="")
    c_run.set_defaults(_handler=cmd_compare_run)

    # --- api (raw escape hatch) ---
    api = sub.add_parser(
        "api", help="Raw passthrough to any /api endpoint (in-process ASGI, no server)."
    )
    api.add_argument("method", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    api.add_argument("path", help="API path, e.g. /api/tasks.")
    api.add_argument("-d", "--data", default=None, help="JSON body (inline).")
    api.add_argument("--data-file", dest="data_file", default=None, help="JSON body from file.")
    api.set_defaults(_handler=cmd_api)

    # --- export / import (portable bundles) ---
    exp = sub.add_parser("export", help="Export tasks/samples/prompts to a portable bundle file.")
    exp.add_argument("--task", action="append", default=[], help="Task id/name/#index. Repeatable.")
    exp.add_argument(
        "--sample-set",
        "--sset",
        dest="sample_set",
        action="append",
        default=[],
        help="Sample set id/name. Repeatable.",
    )
    exp.add_argument("--prompt", action="append", default=[], help="Prompt id. Repeatable.")
    exp.add_argument(
        "--provider", action="append", default=[], help="Provider config id. Repeatable."
    )
    exp.add_argument("--all", dest="all_", action="store_true", help="Export the full workspace.")
    exp.add_argument("-o", "--out", required=True, help="Output file path (.mikobundle or .zip).")
    exp.add_argument(
        "--no-assets", dest="no_assets", action="store_true", help="Do not bundle image assets."
    )
    exp.set_defaults(_handler=cmd_export)

    imp = sub.add_parser("import", help="Import a portable bundle file.")
    imp.add_argument("path", help="Bundle file path (.mikobundle or .zip).")
    imp.add_argument(
        "--mode", choices=["skip", "overwrite", "duplicate"], default="skip"
    )
    imp.add_argument(
        "--dry-run", dest="dry_run", action="store_true", help="Preview without writing."
    )
    imp.add_argument(
        "--no-assets", dest="no_assets", action="store_true", help="Do not restore image assets."
    )
    imp.set_defaults(_handler=cmd_import)

    return p


async def _amain(argv: list[str]) -> int:
    global _JSON_MODE
    parser = _build_parser()
    args = parser.parse_args(argv)
    _JSON_MODE = _want_json(args)

    # Bootstrap: create tables / run migrations against the shared data dir.
    await init_db()

    handler: Callable[[argparse.Namespace], Any] = args._handler
    await handler(args)
    return 0


def main() -> None:
    if os.environ.get("MIKO_CLI_DEBUG"):
        asyncio.run(_amain(sys.argv[1:]))
        return

    try:
        rc = asyncio.run(_amain(sys.argv[1:]))
    except KeyboardInterrupt:
        rc = 130
    except SystemExit:
        raise
    except RefResolutionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        rc = 67
    except DeriveError as exc:
        print(f"error: {exc}", file=sys.stderr)
        rc = exc.exit_code
    except FilterError as exc:
        print(f"error: {exc}", file=sys.stderr)
        rc = 65
    except Exception as exc:  # noqa: BLE001 — top-level CLI guard.
        # Translate backend HTTPException (the only typed error the handlers raise).
        status = getattr(exc, "status_code", None)
        detail = getattr(exc, "detail", None) or str(exc)
        prefix = f"[{status}] " if status else ""
        print(f"error: {prefix}{detail}", file=sys.stderr)
        rc = 1
    sys.exit(rc)


if __name__ == "__main__":
    main()
