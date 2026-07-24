"""Bounding box schema for bbox output parsing.

BBox parser is an optional extension to OutputContract that extracts
bboxes from raw model text (e.g. Qwen-style ``bbox:[x1,y1,x2,y2]: desc``).
Internal BBox representation is always normalized [0,1] xyxy.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class BBoxOrder(str, Enum):
    XYXY = "xyxy"
    YXYX = "yxyx"
    XYWH = "xywh"
    CXCYWH = "cxcywh"


class BBoxSpace(str, Enum):
    NORMALIZED_1000 = "normalized_1000"  # 0-1000
    NORMALIZED_1 = "normalized_1"        # 0-1


class BBoxFormat(BaseModel):
    order: BBoxOrder = BBoxOrder.XYXY
    space: BBoxSpace = BBoxSpace.NORMALIZED_1000


class BBoxParser(BaseModel):
    """Declarative bbox extractor config. Attach to OutputContract.bbox_parser."""

    image_slot: str                              # 绑定 ImageSlotSpec.slot_id
    preset: str | None = None                    # 与 pattern 互斥
    pattern: str | None = None                   # 自定义正则（Python re 语法）
    coord_groups: list[int] | None = None        # 自定义模式下必填：4 个 group 索引
    label_group: int | None = None               # 自定义模式下可选：label group 索引
    format: BBoxFormat = Field(default_factory=BBoxFormat)


class BBox(BaseModel):
    """Internal normalized bbox. Always xyxy in [0,1]."""

    x1: float
    y1: float
    x2: float
    y2: float
    label: str | None = None
    raw_match: str = ""                          # 调试用：原始匹配片段


# 内置预设：name -> (compiled_pattern, coord_group_indices, label_group_index, default_format)
# 在 bbox_extractor.py 里维护这张表
