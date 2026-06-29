"""Generate self-contained Markdown reproduction documents for task versions.

Unlike :mod:`input_spec_generator` (which emits machine-consumed import
formats for *this tool*), this module emits a human-readable document that
lets an external agent or engineer reproduce a *tuned* annotation task at
scale, without any access to the tool itself.

Design notes
------------
* The document is written in Chinese to match the product's primary locale.
* It is deliberately self-contained: prompts are rendered verbatim, input
  slots and the output contract are translated into readable tables, and
  optional few-shot examples show the variable→output correspondence.
* Sensitive data is never included: no API keys and no endpoint base URLs.
  Model/provider information is advisory only.
"""

from __future__ import annotations

import json
from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.provider_config import ProviderConfigORM
from app.models.result_snapshot import ResultSnapshotORM
from app.models.run import RunItemORM, RunSessionORM
from app.models.task import TaskORM, TaskVersionORM
from app.schemas.common import (
    OutputMode,
    RunItemType,
    RunSessionStatus,
    RunType,
    utc_now,
)
from app.schemas.model_config import ModelParameters
from app.schemas.output_contract import OutputContract
from app.schemas.prompt import ImageSlotSpec, VariableSpec

_MAX_EXAMPLES = 5
_USAGE_HIGH = 50
_USAGE_MEDIUM = 10


# ---------------------------------------------------------------------------
# Small formatting helpers
# ---------------------------------------------------------------------------


def _fence(text: str, lang: str = "") -> str:
    """Wrap text in a fenced code block.

    The fence is lengthened beyond the longest backtick run found inside the
    content so an embedded ``` triple-backtick can never break the block.
    """
    body = text if text.endswith("\n") else text + "\n"
    longest = 0
    run = 0
    for ch in body:
        if ch == "`":
            run += 1
            longest = longest if longest > run else run
        else:
            run = 0
    fence = "`" * max(3, longest + 1)
    return f"{fence}{lang}\n{body}{fence}"


def _count_range(min_count: int, max_count: int | None) -> str:
    if max_count is None:
        return f"{min_count}+" if min_count and min_count > 1 else "≥1"
    if min_count == max_count:
        return str(max_count)
    return f"{min_count}–{max_count}"


def _cell(value: Any) -> str:
    """Render a table cell, collapsing empty values to a placeholder and
    escaping pipes so user-supplied text can't break the table layout."""
    if value is None:
        return "-"
    text = str(value).strip()
    if text == "":
        return "-"
    return text.replace("|", "\\|").replace("\n", " ")


# ---------------------------------------------------------------------------
# Section renderers
# ---------------------------------------------------------------------------


def _render_image_slots(slots: list[ImageSlotSpec]) -> str:
    if not slots:
        return ""
    lines = [
        "#### 图像槽位",
        "",
        "| 槽位 ID | 用途 (role) | 标签 | 必填 | 数量 | 说明 |",
        "|---|---|---|---|---|---|",
    ]
    for s in slots:
        role = s.role_hint or s.slot_id
        lines.append(
            f"| `{s.slot_id}` | {_cell(role)} | {_cell(s.label)} |"
            f" {'是' if s.required else '否'} |"
            f" {_count_range(s.min_count, s.max_count)} |"
            f" {_cell(s.description)} |"
        )
    return "\n".join(lines)


def _render_variable_slots(specs: list[VariableSpec]) -> str:
    if not specs:
        return ""
    lines = [
        "#### 变量槽位",
        "",
        "| 变量 ID | 类型 | 必填 | 默认值 | 说明 |",
        "|---|---|---|---|---|",
    ]
    for s in specs:
        default = s.default_value if s.default_value not in (None, "") else "-"
        lines.append(
            f"| `{s.var_id}` | {_cell(s.type)} |"
            f" {'是' if s.required else '否'} |"
            f" {_cell(default)} | {_cell(s.description)} |"
        )
    return "\n".join(lines)


def _render_image_preprocess(cfg: dict[str, Any]) -> str:
    if not cfg:
        return ""
    known = (
        "enabled",
        "max_dimension",
        "target_longest_side",
        "target",
        "min_dimension",
    )
    parts = [f"`{k}` = `{cfg[k]}`" for k in known if cfg.get(k) is not None]
    if not parts:
        return ""
    return "- **图像预处理**: " + ", ".join(parts)


def _flatten_json_schema(
    schema: dict[str, Any], prefix: str = ""
) -> list[tuple[str, str, str, str]]:
    """Recursively flatten a JSON Schema into (path, type, required, desc) rows."""
    rows: list[tuple[str, str, str, str]] = []
    props = schema.get("properties")
    if not isinstance(props, dict):
        return rows
    required = set(schema.get("required") or [])
    for name, sub in props.items():
        if not isinstance(sub, dict):
            continue
        path = f"{prefix}.{name}" if prefix else name
        typ = sub.get("type", "")
        if isinstance(typ, list):
            typ = " | ".join(str(t) for t in typ)
        if sub.get("enum"):
            enum_vals = ", ".join(str(e) for e in sub["enum"])
            typ = f"{typ} (enum: {enum_vals})" if typ else f"enum: {enum_vals}"
        req = "是" if name in required else "否"
        desc = sub.get("description", "")
        rows.append((path, str(typ) or "-", req, str(desc) if desc else "-"))

        sub_type = sub.get("type")
        if sub_type == "object" and isinstance(sub.get("properties"), dict):
            rows.extend(_flatten_json_schema(sub, path))
        elif (
            sub_type == "array"
            and isinstance(sub.get("items"), dict)
        ):
            item = sub["items"]
            item_type = item.get("type", "")
            arr_path = f"{path}[]"
            rows.append(
                (arr_path, f"array[{item_type or '-'}]", req, str(item.get("description", "-")))
            )
            if item.get("type") == "object" and isinstance(item.get("properties"), dict):
                rows.extend(_flatten_json_schema(item, arr_path))
    return rows


def _render_output_contract(contract: OutputContract) -> str:
    mode = contract.mode
    lines: list[str] = [f"- 输出模式: `{mode.value}`"]

    if mode == OutputMode.FREE_TEXT:
        lines.append("- 模型自由输出文本，无强制结构。")
    elif mode == OutputMode.SOFT_SECTIONS:
        lines.append("- 期望按章节组织输出（软约束，模型可灵活排版）。")
        opts = (contract.parser.options if contract.parser else {}) or {}
        raw_names = opts.get("section_names")
        if raw_names is None:
            # Backward compatibility: older clients stored the list under "sections".
            raw_names = opts.get("sections", [])
        if isinstance(raw_names, list) and raw_names:
            lines.append(
                "- 期望章节（节标记）: " + ", ".join(f"`{name}`" for name in raw_names)
            )
    elif mode in (OutputMode.STRICT_JSON, OutputMode.LOOSE_JSON):
        strict = mode == OutputMode.STRICT_JSON
        lines.append(
            f"- 模型须输出 {'严格' if strict else '宽松'} JSON。"
        )
        schema = contract.json_schema
        if isinstance(schema, dict) and schema:
            rows = _flatten_json_schema(schema)
            if rows:
                lines += [
                    "",
                    "| 字段路径 | 类型 | 必填 | 说明 |",
                    "|---|---|---|---|",
                ]
                lines += [
                    f"| `{path}` | {typ} | {req} | {_cell(desc)} |"
                    for path, typ, req, desc in rows
                ]
            else:
                lines.append("- JSON Schema 存在但无可枚举字段，原始结构如下：")
                lines.append("")
                lines.append(_fence(json.dumps(schema, ensure_ascii=False, indent=2), "json"))
        else:
            lines.append("- 未提供 JSON Schema。")
    elif mode == OutputMode.CUSTOM:
        if contract.parser and contract.parser.type:
            lines.append(f"- 自定义解析器: `{contract.parser.type}`")

    return "\n".join(lines)


_PARAM_ROWS = (
    ("temperature", "temperature"),
    ("max_output_tokens", "max_output_tokens"),
    ("top_p", "top_p"),
    ("seed", "seed"),
    ("stop", "stop"),
    ("enable_thinking", "enable_thinking"),
    ("thinking_budget", "thinking_budget"),
    ("reasoning_effort", "reasoning_effort"),
)


def _render_model_parameters(params: ModelParameters) -> str:
    rows: list[tuple[str, str]] = []
    for attr, label in _PARAM_ROWS:
        value = getattr(params, attr, None)
        if value is None:
            continue
        if attr == "stop" and isinstance(value, list):
            value = ", ".join(str(v) for v in value) if value else None
            if value is None:
                continue
        rows.append((label, str(value)))
    if not rows:
        return "（使用模型默认参数）"
    lines = ["| 参数 | 值 |", "|---|---|"]
    lines += [f"| `{label}` | `{val}` |" for label, val in rows]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Data access
# ---------------------------------------------------------------------------


async def _resolve_adapter_id(db: AsyncSession, provider_config_id: str | None) -> str | None:
    if not provider_config_id:
        return None
    result = await db.execute(
        select(ProviderConfigORM.adapter_id).where(
            ProviderConfigORM.provider_config_id == provider_config_id
        )
    )
    return result.scalar_one_or_none()


async def _collect_usage_stats(
    db: AsyncSession, task_version_id: str
) -> dict[str, Any]:
    """Aggregate token/cost usage across completed runs of this task version.

    Mirrors the filtering used by the cost-stats endpoint: completed batch/lab
    sessions whose source points at this version, and their succeeded items.
    """
    sessions_result = await db.execute(
        select(RunSessionORM).where(
            RunSessionORM.run_type.in_([RunType.BATCH.value, RunType.LAB.value]),
            RunSessionORM.status.in_(
                [RunSessionStatus.COMPLETED.value, RunSessionStatus.COMPLETED_WITH_ERRORS.value]
            ),
        )
    )
    run_ids = [
        session.run_id
        for session in sessions_result.scalars().all()
        if (session.source or {}).get("task_version_id") == task_version_id
    ]

    items: list[RunItemORM] = []
    if run_ids:
        items_result = await db.execute(
            select(RunItemORM).where(
                RunItemORM.run_id.in_(run_ids),
                RunItemORM.status.in_([RunItemType.SUCCEEDED.value, "completed"]),
            )
        )
        items = list(items_result.scalars().all())

    count = len(items)

    def _mean(field: str) -> float:
        values = [
            float(it.usage.get(field) or 0)
            for it in items
            if (it.usage or {}).get(field) is not None
        ]
        return sum(values) / len(values) if values else 0.0

    currency = "USD"
    for it in items:
        snapshot = it.pricing_snapshot or {}
        if isinstance(snapshot, dict) and snapshot.get("currency"):
            currency = snapshot["currency"]
            break

    confidence = "none"
    if count >= _USAGE_HIGH:
        confidence = "high"
    elif count >= _USAGE_MEDIUM:
        confidence = "medium"
    elif count > 0:
        confidence = "low"

    return {
        "sample_count": count,
        "run_count": len(run_ids),
        "avg_input_tokens": _mean("input_tokens"),
        "avg_output_tokens": _mean("output_tokens"),
        "avg_total_tokens": _mean("total_tokens"),
        "avg_cost": sum(float(it.estimated_cost or 0.0) for it in items) / count
        if count
        else 0.0,
        "currency": currency,
        "confidence": confidence,
    }


def _render_usage_stats(stats: dict[str, Any]) -> str:
    count = stats["sample_count"]
    if count == 0:
        return ""
    lines = [
        f"- **样本数**: {count}（来自 {stats['run_count']} 次已完成运行）",
        f"- **平均输入 tokens**: {stats['avg_input_tokens']:.0f}",
        f"- **平均输出 tokens**: {stats['avg_output_tokens']:.0f}",
        f"- **平均总 tokens**: {stats['avg_total_tokens']:.0f}",
    ]
    if stats["avg_cost"] > 0:
        lines.append(
            f"- **平均单次成本**: {stats['avg_cost']:.4f} {stats['currency']}"
        )
    note = {
        "high": "_（数据充足）_",
        "medium": "_（数据中等）_",
        "low": "_（样本较少，仅供参考）_",
    }.get(stats["confidence"], "")
    if note:
        lines.append(note)
    return "\n".join(lines)


async def _load_examples(
    db: AsyncSession, task_version_id: str, limit: int
) -> list[tuple[ResultSnapshotORM, RunItemORM | None]]:
    stmt = (
        select(ResultSnapshotORM, RunItemORM)
        .outerjoin(
            RunItemORM,
            RunItemORM.run_item_id == ResultSnapshotORM.run_item_id,
        )
        .where(ResultSnapshotORM.linked_task_version_id == task_version_id)
        .order_by(ResultSnapshotORM.created_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    return [(snap, item) for snap, item in rows]


def _render_example(index: int, snap: ResultSnapshotORM, run_item: RunItemORM | None) -> str:
    name = snap.name or f"snapshot {snap.snapshot_id[:8]}"
    req = snap.internal_request_snapshot or {}
    prompt_spec = req.get("prompt") or {}
    render_ctx = prompt_spec.get("render_context") or {}
    vars_dict = render_ctx.get("vars") or {}
    images = req.get("images") or []
    role_counts: Counter[str] = Counter(
        (img.get("role") or "image")
        for img in images
        if isinstance(img, dict)
    )

    resp = (run_item.response if run_item is not None else None) or {}
    response_text = resp.get("raw_text")
    parsed = resp.get("parsed")

    blocks = [f"### 示例 {index}: {name}"]
    if isinstance(vars_dict, dict) and vars_dict:
        var_line = ", ".join(f"`{k}` = `{v}`" for k, v in vars_dict.items())
        blocks.append(f"- **输入变量**: {var_line}")
    if role_counts:
        img_line = ", ".join(
            f"[{role}: {n} 张]" for role, n in role_counts.items()
        )
        blocks.append(f"- **图像**: {img_line}")
    user_prompt = prompt_spec.get("user_prompt")
    if user_prompt:
        blocks.append("- **User Prompt（填实后）**:")
        blocks.append(_fence(user_prompt))
    if response_text:
        blocks.append("- **模型输出**:")
        blocks.append(_fence(response_text))
    if parsed is not None:
        blocks.append("- **解析结果**:")
        blocks.append(_fence(json.dumps(parsed, ensure_ascii=False, indent=2), "json"))
    return "\n\n".join(blocks)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


async def generate_task_doc(
    task: TaskORM,
    task_version: TaskVersionORM,
    db: AsyncSession,
    *,
    include_examples: bool = True,
) -> str:
    """Render a self-contained Markdown reproduction document for a task version."""
    image_slots = [ImageSlotSpec(**item) for item in (task_version.image_slot_specs or [])]
    variable_specs = [VariableSpec(**item) for item in (task_version.variable_specs or [])]
    params = ModelParameters(**(task_version.model_parameters or {}))
    contract = OutputContract(**(task_version.output_contract or {}))
    preprocess = task_version.image_preprocess_config or {}

    adapter_id = await _resolve_adapter_id(db, task_version.provider_config_id)
    usage_stats = await _collect_usage_stats(db, task_version.task_version_id)
    examples: list[tuple[ResultSnapshotORM, RunItemORM | None]] = []
    if include_examples:
        examples = await _load_examples(db, task_version.task_version_id, _MAX_EXAMPLES)

    sections: list[str] = []

    # Title + meta
    title = f"# {task.name or task.task_id} · 标注任务规格"
    meta_lines = [
        f"> **版本**: `{task_version.version_label}`",
        f"> **Task ID**: `{task.task_id}`",
        f"> **Version ID**: `{task_version.task_version_id}`",
    ]
    if task.description:
        meta_lines.append(f"> **描述**: {task.description}")
    if getattr(task, "tags", None):
        meta_lines.append(
            "> **标签**: " + ", ".join(f"`{t}`" for t in task.tags)
        )
    meta_lines.append(f"> **生成时间**: {utc_now().isoformat(timespec='seconds')}")
    sections.append(title + "\n\n" + "\n".join(meta_lines))

    # 1. Task overview
    overview_parts: list[str] = ["## 1. 任务说明"]
    if task.description:
        overview_parts.append(task.description)
    if task_version.notes:
        overview_parts.append(f"**版本备注**:\n\n{task_version.notes}")
    if not task.description and not task_version.notes:
        overview_parts.append("_(无说明)_")
    sections.append("\n\n".join(overview_parts))

    # 2. Model config (advisory)
    model_parts = ["## 2. 模型配置（参考）"]
    model_parts.append(
        f"- **提供商适配器**: `{adapter_id}`" if adapter_id else "- **提供商适配器**: -"
    )
    model_parts.append(f"- **模型**: `{task_version.model_id}`")
    model_parts.append(_render_model_parameters(params))
    model_parts.append(
        "_模型信息仅作参考；复现时可使用等效模型。文档不含端点地址与密钥。_"
    )
    sections.append("\n".join(model_parts))

    # 3. System prompt
    if task_version.system_prompt.strip():
        sections.append(
            "## 3. System Prompt\n\n" + _fence(task_version.system_prompt)
        )

    # 4. User prompt template
    template_parts = ["## 4. User Prompt 模板"]
    if task_version.user_template.strip():
        template_parts.append(_fence(task_version.user_template))
    else:
        template_parts.append("_(空模板)_")
    template_parts.append(
        "**占位符说明**:\n"
        "- `{{vars.<var_id>}}` — 替换为对应变量槽位的值\n"
        "- `{{#vars.<var_id>}}...{{/vars.<var_id>}}` — 条件块：变量为真（非空）时渲染内部内容\n"
        "- `{{^vars.<var_id>}}...{{/vars.<var_id>}}` — 条件块：变量为假或为空时渲染内部内容\n"
        "- `{{image:<索引>}}` — 图文交错时，标记第 `<索引>` 张图像插入的位置（如 `{{image:0}}`）"
    )
    sections.append("\n\n".join(template_parts))

    # 5. Input spec
    input_parts = ["## 5. 输入规范"]
    image_table = _render_image_slots(image_slots)
    var_table = _render_variable_slots(variable_specs)
    if image_table:
        input_parts.append(image_table)
    if var_table:
        input_parts.append(var_table)
    preprocess_line = _render_image_preprocess(preprocess)
    if preprocess_line:
        input_parts.append(preprocess_line)
    if not image_table and not var_table:
        input_parts.append("_(无图像槽位或变量槽位)_")
    sections.append("\n\n".join(input_parts))

    # 6. Output contract
    sections.append("## 6. 输出规范\n\n" + _render_output_contract(contract))

    # 7. Usage stats
    usage_md = _render_usage_stats(usage_stats)
    if usage_md:
        sections.append("## 7. 消耗统计\n\n" + usage_md)

    # 8. Examples
    if examples:
        ex_blocks = [f"## 8. 复现示例（共 {len(examples)} 个）"]
        for idx, (snap, item) in enumerate(examples, start=1):
            ex_blocks.append(_render_example(idx, snap, item))
        sections.append("\n\n".join(ex_blocks))

    return "\n\n".join(sections) + "\n"
