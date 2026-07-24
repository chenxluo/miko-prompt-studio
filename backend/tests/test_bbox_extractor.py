"""Tests for bbox_extractor and its integration with OutputContract / parser_engine."""

from __future__ import annotations

import pytest

from app.schemas.bbox import BBoxFormat, BBoxOrder, BBoxParser, BBoxSpace
from app.schemas.common import OutputMode, ParseStatus
from app.schemas.output_contract import OutputContract, ParserConfig
from app.services.bbox_extractor import extract_bboxes
from app.services.parser_engine import parse_response

_QWEN_SAMPLE_TEXT = (
    "The image shows a person.\n"
    "bbox:[45,55,570,960]: A dominant full-body front view of a woman in white dress.\n"
    "bbox:[600,400,750,800]: A handbag held in her right hand.\n"
)


@pytest.fixture
def qwen_contract() -> OutputContract:
    return OutputContract(
        mode=OutputMode.FREE_TEXT,
        bbox_parser=BBoxParser(image_slot="image", preset="qwen_inline"),
    )


class TestExtractBboxesPresets:
    """Preset-based extraction."""

    def test_qwen_inline_preset_extracts_two_boxes(self) -> None:
        parser = BBoxParser(image_slot="image", preset="qwen_inline")
        boxes, warnings = extract_bboxes(_QWEN_SAMPLE_TEXT, parser)

        assert len(boxes) == 2
        assert warnings == []

        b1, b2 = boxes
        assert b1.x1 == pytest.approx(0.045)
        assert b1.y1 == pytest.approx(0.055)
        assert b1.x2 == pytest.approx(0.570)
        assert b1.y2 == pytest.approx(0.960)
        assert b1.label == "A dominant full-body front view of a woman in white dress."

        assert b2.x1 == pytest.approx(0.600)
        assert b2.y1 == pytest.approx(0.400)
        assert b2.x2 == pytest.approx(0.750)
        assert b2.y2 == pytest.approx(0.800)
        assert b2.label == "A handbag held in her right hand."

    def test_gemini_inline_preset_swaps_order_to_yxyx(self) -> None:
        """gemini_inline uses the same raw text pattern but interprets coords as yxyx."""
        parser = BBoxParser(image_slot="image", preset="gemini_inline")
        boxes, warnings = extract_bboxes(_QWEN_SAMPLE_TEXT, parser)

        assert len(boxes) == 2
        assert warnings == []

        b1, b2 = boxes
        # raw [45,55,570,960] read as yxyx -> (x1,y1,x2,y2) = (55/1000, 45/1000, 960/1000, 570/1000)
        assert b1.x1 == pytest.approx(0.055)
        assert b1.y1 == pytest.approx(0.045)
        assert b1.x2 == pytest.approx(0.960)
        assert b1.y2 == pytest.approx(0.570)

        assert b2.x1 == pytest.approx(0.400)
        assert b2.y1 == pytest.approx(0.600)
        assert b2.x2 == pytest.approx(0.800)
        assert b2.y2 == pytest.approx(0.750)

    def test_bracket_only_preset_has_no_label(self) -> None:
        text = "Detected boxes: [10,20,300,400] and [500,600,700,800]"
        parser = BBoxParser(image_slot="image", preset="bracket_only")
        boxes, warnings = extract_bboxes(text, parser)

        assert len(boxes) == 2
        assert warnings == []
        assert all(b.label is None for b in boxes)
        assert boxes[0].x1 == pytest.approx(0.010)
        assert boxes[0].y1 == pytest.approx(0.020)
        assert boxes[0].x2 == pytest.approx(0.300)
        assert boxes[0].y2 == pytest.approx(0.400)

    def test_preset_clamps_coordinates_to_unit_interval(self) -> None:
        parser = BBoxParser(image_slot="image", preset="qwen_inline")
        boxes, warnings = extract_bboxes(
            "bbox:[900,200,1700,1200]: out of bounds", parser
        )

        assert warnings == []
        assert boxes[0].model_dump(include={"x1", "y1", "x2", "y2"}) == {
            "x1": pytest.approx(0.9),
            "y1": pytest.approx(0.2),
            "x2": pytest.approx(1.0),
            "y2": pytest.approx(1.0),
        }


class TestExtractBboxesCustom:
    """Custom regex / format settings."""

    def test_custom_pattern_with_coord_groups_and_label(self) -> None:
        text = "region[100, 200, 300, 400]: the first object"
        parser = BBoxParser(
            image_slot="image",
            pattern=r"region\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]\s*[:：]\s*(.+)",
            coord_groups=[1, 2, 3, 4],
            label_group=5,
        )
        boxes, warnings = extract_bboxes(text, parser)

        assert len(boxes) == 1
        assert warnings == []
        assert boxes[0].label == "the first object"
        assert boxes[0].x1 == pytest.approx(0.100)
        assert boxes[0].y1 == pytest.approx(0.200)
        assert boxes[0].x2 == pytest.approx(0.300)
        assert boxes[0].y2 == pytest.approx(0.400)

    def test_custom_pattern_format_normalized_1(self) -> None:
        text = "region[0.1, 0.2, 0.3, 0.4]: small"
        parser = BBoxParser(
            image_slot="image",
            pattern=r"region\[(\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+\.?\d*)\]\s*[:：]\s*(.+)",
            coord_groups=[1, 2, 3, 4],
            label_group=5,
            format=BBoxFormat(order=BBoxOrder.XYXY, space=BBoxSpace.NORMALIZED_1),
        )
        boxes, warnings = extract_bboxes(text, parser)

        assert len(boxes) == 1
        assert warnings == []
        assert boxes[0].x1 == pytest.approx(0.1)
        assert boxes[0].y1 == pytest.approx(0.2)
        assert boxes[0].x2 == pytest.approx(0.3)
        assert boxes[0].y2 == pytest.approx(0.4)

    def test_custom_pattern_xywh_order(self) -> None:
        text = "region[100, 200, 300, 400]: wh"
        parser = BBoxParser(
            image_slot="image",
            pattern=r"region\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]\s*[:：]\s*(.+)",
            coord_groups=[1, 2, 3, 4],
            label_group=5,
            format=BBoxFormat(order=BBoxOrder.XYWH, space=BBoxSpace.NORMALIZED_1000),
        )
        boxes, warnings = extract_bboxes(text, parser)

        assert len(boxes) == 1
        assert warnings == []
        # x=100, y=200, w=300, h=400 -> (0.1, 0.2, 0.4, 0.6)
        assert boxes[0].x1 == pytest.approx(0.1)
        assert boxes[0].y1 == pytest.approx(0.2)
        assert boxes[0].x2 == pytest.approx(0.4)
        assert boxes[0].y2 == pytest.approx(0.6)

    def test_custom_pattern_cxcywh_order(self) -> None:
        text = "region[500, 500, 200, 200]: center"
        parser = BBoxParser(
            image_slot="image",
            pattern=r"region\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]\s*[:：]\s*(.+)",
            coord_groups=[1, 2, 3, 4],
            label_group=5,
            format=BBoxFormat(order=BBoxOrder.CXCYWH, space=BBoxSpace.NORMALIZED_1000),
        )
        boxes, warnings = extract_bboxes(text, parser)

        assert len(boxes) == 1
        assert warnings == []
        # cx=500, cy=500, w=200, h=200 -> (0.4, 0.4, 0.6, 0.6)
        assert boxes[0].x1 == pytest.approx(0.4)
        assert boxes[0].y1 == pytest.approx(0.4)
        assert boxes[0].x2 == pytest.approx(0.6)
        assert boxes[0].y2 == pytest.approx(0.6)


class TestExtractBboxesWarnings:
    """Error/warning handling."""

    def test_degenerate_bbox_is_extracted_with_warning(self) -> None:
        text = "bbox:[100,100,50,50]: bad"
        parser = BBoxParser(image_slot="image", preset="qwen_inline")
        boxes, warnings = extract_bboxes(text, parser)

        assert len(boxes) == 1
        assert boxes[0].x1 == pytest.approx(0.100)
        assert boxes[0].x2 == pytest.approx(0.050)
        assert any(w["type"] == "bbox_degenerate" for w in warnings)

    def test_invalid_config_preset_and_pattern(self) -> None:
        parser = BBoxParser(
            image_slot="image",
            preset="qwen_inline",
            pattern=r"some pattern",
        )
        boxes, warnings = extract_bboxes("anything", parser)
        assert boxes == []
        assert any(w["type"] == "bbox_config_error" for w in warnings)

    def test_unknown_preset(self) -> None:
        parser = BBoxParser(image_slot="image", preset="not_exist")
        boxes, warnings = extract_bboxes("anything", parser)
        assert boxes == []
        assert any(w["type"] == "bbox_config_error" for w in warnings)

    def test_custom_coord_groups_wrong_length(self) -> None:
        parser = BBoxParser(
            image_slot="image",
            pattern=r"(\d+),\s*(\d+),\s*(\d+),\s*(\d+)",
            coord_groups=[1, 2, 3],
        )
        boxes, warnings = extract_bboxes("1,2,3,4", parser)
        assert boxes == []
        assert any(w["type"] == "bbox_config_error" for w in warnings)

    def test_no_bbox_text_returns_empty(self) -> None:
        text = "The image shows a person standing in a park."
        parser = BBoxParser(image_slot="image", preset="qwen_inline")
        boxes, warnings = extract_bboxes(text, parser)
        assert boxes == []
        assert warnings == []

    def test_xml_tag_preset(self) -> None:
        text = "<box>10,20,30,40</box> first\n<box>50,60,70,80</box> second"
        parser = BBoxParser(image_slot="image", preset="xml_tag")
        boxes, warnings = extract_bboxes(text, parser)
        assert len(boxes) == 2
        assert warnings == []
        assert boxes[0].label == "first"
        assert boxes[1].label == "second"


class TestParserEngineIntegration:
    """Integration through parse_response."""

    def test_free_text_with_bbox_parser_populates_boxes(
        self, qwen_contract: OutputContract
    ) -> None:
        parsed = parse_response(_QWEN_SAMPLE_TEXT, qwen_contract)

        assert parsed.parse_status == ParseStatus.NOT_PARSED
        assert parsed.parsed == _QWEN_SAMPLE_TEXT
        assert parsed.boxes is not None
        assert len(parsed.boxes) == 2
        assert parsed.parse_errors == []

    def test_free_text_without_bbox_parser_keeps_boxes_none(self) -> None:
        contract = OutputContract(mode=OutputMode.FREE_TEXT)
        parsed = parse_response("No boxes here", contract)

        assert parsed.boxes is None
        assert parsed.parse_errors == []

    def test_soft_sections_and_bbox_parser_are_independent(self) -> None:
        text = (
            "分类: 拼接图\n\n"
            "理由\n"
            "该图像由两张独立照片水平拼接而成\n"
            "bbox:[10,20,30,40]: extra annotation"
        )
        contract = OutputContract(
            mode=OutputMode.SOFT_SECTIONS,
            parser=ParserConfig(
                type="soft_sections",
                options={"section_names": ["分类", "理由"]},
            ),
            bbox_parser=BBoxParser(image_slot="image", preset="qwen_inline"),
        )
        parsed = parse_response(text, contract)

        assert parsed.parse_status == ParseStatus.PARSED
        # 主解析按原样保留文本；bbox 行作为理由区段内容的一部分被保留。
        assert parsed.parsed == {
            "分类": "拼接图",
            "理由": "该图像由两张独立照片水平拼接而成\nbbox:[10,20,30,40]: extra annotation",
        }
        assert parsed.boxes is not None
        assert len(parsed.boxes) == 1
        assert parsed.boxes[0].x1 == pytest.approx(0.010)
        assert parsed.boxes[0].label == "extra annotation"
        # Soft-section parser itself has no errors, and bbox extraction succeeded.
        assert all(e["type"] != "bbox_config_error" for e in parsed.parse_errors)

    def test_degenerate_bbox_is_appended_to_parse_errors(self) -> None:
        text = "bbox:[100,100,50,50]: bad"
        contract = OutputContract(
            mode=OutputMode.FREE_TEXT,
            bbox_parser=BBoxParser(image_slot="image", preset="qwen_inline"),
        )
        parsed = parse_response(text, contract)

        assert parsed.boxes is not None
        assert len(parsed.boxes) == 1
        assert any(e["type"] == "bbox_degenerate" for e in parsed.parse_errors)

    def test_unknown_preset_does_not_break_main_parse(self) -> None:
        contract = OutputContract(
            mode=OutputMode.FREE_TEXT,
            bbox_parser=BBoxParser(image_slot="image", preset="no_such_preset"),
        )
        parsed = parse_response("plain text", contract)

        assert parsed.boxes is not None
        assert parsed.boxes == []
        assert any(e["type"] == "bbox_config_error" for e in parsed.parse_errors)
