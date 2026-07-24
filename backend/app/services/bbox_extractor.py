"""BBox extraction from raw model text.

Two modes via BBoxParser:
- preset: pick a built-in regex template by name
- custom: user supplies regex + coord_groups + optional label_group

Simplification: in preset mode the preset's own default format is always used;
``parser.format`` is ignored. In custom pattern mode ``parser.format`` is used.
This avoids the ambiguity of distinguishing "user left the default format"
from "user explicitly set the default format" in Pydantic v2.
"""

from __future__ import annotations

import re
from contextlib import suppress
from typing import Any

from app.schemas.bbox import BBox, BBoxFormat, BBoxOrder, BBoxParser, BBoxSpace

# ---- 内置预设 ----
# 每项: (preset_name, regex, coord_groups, label_group, default_format)
# 正则要求 4 个捕获组作为坐标（顺序由 coord_groups 指明），1 个可选 label 组
_PRESETS: dict[str, tuple[str, list[int], int | None, BBoxFormat]] = {
    "qwen_inline": (
        # 约定：bbox:[x1,y1,x2,y2]: 描述。冒号形式比等号更不易被模型写错。
        r"bbox\s*[:：]\s*\[(\d+)[,，]\s*(\d+)[,，]\s*(\d+)[,，]\s*(\d+)\]\s*[:：]\s*([^\n]+)",
        [1, 2, 3, 4], 5,
        BBoxFormat(order=BBoxOrder.XYXY, space=BBoxSpace.NORMALIZED_1000),
    ),
    "gemini_inline": (
        # 同 qwen_inline 正则，但默认 order=yxyx
        r"bbox\s*[:：]\s*\[(\d+)[,，]\s*(\d+)[,，]\s*(\d+)[,，]\s*(\d+)\]\s*[:：]\s*([^\n]+)",
        [1, 2, 3, 4], 5,
        BBoxFormat(order=BBoxOrder.YXYX, space=BBoxSpace.NORMALIZED_1000),
    ),
    "bracket_prefix": (
        r"\[(\d+)[,，]\s*(\d+)[,，]\s*(\d+)[,，]\s*(\d+)\]\s*([^\n]+)",
        [1, 2, 3, 4], 5,
        BBoxFormat(order=BBoxOrder.XYXY, space=BBoxSpace.NORMALIZED_1000),
    ),
    "bracket_only": (
        r"\[(\d+)[,，]\s*(\d+)[,，]\s*(\d+)[,，]\s*(\d+)\]",
        [1, 2, 3, 4], None,
        BBoxFormat(order=BBoxOrder.XYXY, space=BBoxSpace.NORMALIZED_1000),
    ),
    "xml_tag": (
        r"<box>(\d+)[,，]\s*(\d+)[,，]\s*(\d+)[,，]\s*(\d+)</box>\s*([^\n]*)",
        [1, 2, 3, 4], 5,
        BBoxFormat(order=BBoxOrder.XYXY, space=BBoxSpace.NORMALIZED_1000),
    ),
}


def extract_bboxes(
    text: str,
    parser: BBoxParser,
) -> tuple[list[BBox], list[dict[str, Any]]]:
    """Extract bboxes from raw model text.

    Returns ``(boxes, warnings)``. Never raises — parse failures become warnings.
    All returned bboxes are normalized to [0,1] xyxy regardless of input format.
    """
    warnings: list[dict[str, Any]] = []

    if parser.preset and parser.pattern:
        return [], [
            {
                "type": "bbox_config_error",
                "message": "Cannot specify both preset and pattern",
            }
        ]

    if parser.preset:
        if parser.preset not in _PRESETS:
            return [], [
                {
                    "type": "bbox_config_error",
                    "message": f"Unknown preset: {parser.preset}",
                }
            ]
        regex_str, coord_groups, label_group, fmt = _PRESETS[parser.preset]
    elif parser.pattern:
        if not parser.coord_groups or len(parser.coord_groups) != 4:
            return [], [
                {
                    "type": "bbox_config_error",
                    "message": "Custom pattern requires coord_groups with 4 indices",
                }
            ]
        regex_str = parser.pattern
        coord_groups = parser.coord_groups
        label_group = parser.label_group
        fmt = parser.format
    else:
        return [], [
            {
                "type": "bbox_config_error",
                "message": "Must specify either preset or pattern",
            }
        ]

    try:
        regex = re.compile(regex_str)
    except re.error as e:
        return [], [{"type": "bbox_regex_error", "message": f"Invalid regex: {e}"}]

    boxes: list[BBox] = []
    for match in regex.finditer(text):
        try:
            raw_coords = [float(match.group(i)) for i in coord_groups]  # type: ignore[arg-type]
        except (IndexError, ValueError, TypeError) as e:
            warnings.append(
                {
                    "type": "bbox_coord_extract_failed",
                    "message": f"Failed to extract coords from match: {e}",
                    "match": match.group(0),
                }
            )
            continue

        label = None
        if label_group is not None:
            with suppress(IndexError):
                label = (match.group(label_group) or "").strip() or None

        normalized = _normalize_coords(raw_coords, fmt)
        if normalized is None:
            warnings.append(
                {
                    "type": "bbox_invalid_coords",
                    "message": (
                        f"Cannot normalize coords {raw_coords} with format {fmt}"
                    ),
                    "match": match.group(0),
                }
            )
            continue

        x1, y1, x2, y2 = normalized
        if x2 <= x1 or y2 <= y1:
            warnings.append(
                {
                    "type": "bbox_degenerate",
                    "message": f"Degenerate bbox (x2<=x1 or y2<=y1): {raw_coords}",
                    "match": match.group(0),
                }
            )

        boxes.append(
            BBox(
                x1=x1,
                y1=y1,
                x2=x2,
                y2=y2,
                label=label,
                raw_match=match.group(0),
            )
        )

    return boxes, warnings


def _normalize_coords(
    coords: list[float], fmt: BBoxFormat
) -> tuple[float, float, float, float] | None:
    """Normalize any input order/space into [0,1] xyxy.

    Returns None if coords are structurally invalid (e.g. wrong length).
    """
    if len(coords) != 4:
        return None
    a, b, c, d = (float(c) for c in coords)

    # Step 1: space normalization -> [0,1]
    if fmt.space == BBoxSpace.NORMALIZED_1000:
        a, b, c, d = a / 1000.0, b / 1000.0, c / 1000.0, d / 1000.0
    # NORMALIZED_1: leave as-is

    # Step 2: order normalization -> xyxy
    if fmt.order == BBoxOrder.XYXY:
        x1, y1, x2, y2 = a, b, c, d
    elif fmt.order == BBoxOrder.YXYX:
        y1, x1, y2, x2 = a, b, c, d
    elif fmt.order == BBoxOrder.XYWH:
        x1, y1, w, h = a, b, c, d
        x2, y2 = x1 + w, y1 + h
    elif fmt.order == BBoxOrder.CXCYWH:
        cx, cy, w, h = a, b, c, d
        x1, y1, x2, y2 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
    else:
        return None

    return tuple(max(0.0, min(1.0, value)) for value in (x1, y1, x2, y2))
