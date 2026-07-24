from app.schemas.bbox import BBoxParser
from app.schemas.common import OutputMode, ParseStatus
from app.schemas.output_contract import OutputContract, ParserConfig
from app.services.parser_engine import parse_response

_QWEN_BBOX_TEXT = (
    "The image shows a person.\n"
    "bbox:[45,55,570,960]: A dominant full-body front view of a woman in white dress.\n"
    "bbox:[600,400,750,800]: A handbag held in her right hand.\n"
)


def _soft_contract(section_names: list[str] | None = None) -> OutputContract:
    return OutputContract(
        mode=OutputMode.SOFT_SECTIONS,
        parser=ParserConfig(
            type="soft_sections",
            options={"section_names": section_names or []},
        ),
    )


def test_soft_sections_matches_configured_chinese_section_names() -> None:
    parsed = parse_response(
        "分类: 拼接图\n\n理由\n该图像由两张独立照片水平拼接而成",
        _soft_contract(["分类", "理由"]),
    )

    assert parsed.parse_status == ParseStatus.PARSED
    assert parsed.parsed == {
        "分类": "拼接图",
        "理由": "该图像由两张独立照片水平拼接而成",
    }


def test_soft_sections_named_headings_accept_markdown_and_colon_formats() -> None:
    cases = [
        ("## 分类\n拼接图", "拼接图"),
        ("分类：拼接图", "拼接图"),
        ("**分类**: 拼接图", "拼接图"),
        ("分类\n拼接图", "拼接图"),
    ]

    for raw_text, expected_content in cases:
        parsed = parse_response(raw_text, _soft_contract(["分类"]))

        assert parsed.parse_status == ParseStatus.PARSED
        assert parsed.parsed == {"分类": expected_content}


def test_soft_sections_ignores_unconfigured_heading_like_lines() -> None:
    parsed = parse_response(
        "分类: 拼接图\n其他: 不应成为新区段\n理由: 命中配置",
        _soft_contract(["分类", "理由"]),
    )

    assert parsed.parse_status == ParseStatus.PARSED
    assert parsed.parsed == {
        "分类": "拼接图\n其他: 不应成为新区段",
        "理由": "命中配置",
    }


def test_soft_sections_falls_back_to_heuristics_without_section_names() -> None:
    parsed = parse_response("任意标题: 内容", _soft_contract())

    assert parsed.parse_status == ParseStatus.PARSED
    assert parsed.parsed == {"任意标题": "内容"}


def test_soft_sections_parses_bracket_delimiters_without_splitting_body_colons() -> None:
    """Regression: bracket delimiters like [[TC]] must not be confused with the
    ``name: value`` heuristic. Body lines that themselves contain a fullwidth
    colon (e.g. ``1. 服装：...``) must stay inside their section."""
    raw_text = (
        "[[TC]]\n这是一张室内人像照片。\n\n"
        "[[CS]]\n近景（CU）、平拍视角\n\n"
        "[[DS]]\n1. 服装：深蓝色高领；2. 姿势：双手举着小番茄；3. 风格：日常休闲风"
    )
    parsed = parse_response(raw_text, _soft_contract(["[[TC]]", "[[CS]]", "[[DS]]"]))

    assert parsed.parse_status == ParseStatus.PARSED
    assert parsed.parsed == {
        "[[TC]]": "这是一张室内人像照片。",
        "[[CS]]": "近景（CU）、平拍视角",
        "[[DS]]": "1. 服装：深蓝色高领；2. 姿势：双手举着小番茄；3. 风格：日常休闲风",
    }
    assert "1. 服装" not in (parsed.parsed or {})


def test_soft_sections_reads_legacy_sections_option_key() -> None:
    """Older clients stored section names under the ``sections`` option key and
    used parser type ``sections``. Those stored contracts must still parse."""
    contract = OutputContract(
        mode=OutputMode.SOFT_SECTIONS,
        parser=ParserConfig(type="sections", options={"sections": ["分类", "理由"]}),
    )
    parsed = parse_response("分类: 拼接图\n\n理由\n两张独立照片", contract)

    assert parsed.parse_status == ParseStatus.PARSED
    assert parsed.parsed == {"分类": "拼接图", "理由": "两张独立照片"}


def test_free_text_with_bbox_parser_extracts_boxes() -> None:
    contract = OutputContract(
        mode=OutputMode.FREE_TEXT,
        bbox_parser=BBoxParser(image_slot="image", preset="qwen_inline"),
    )
    parsed = parse_response(_QWEN_BBOX_TEXT, contract)

    assert parsed.parse_status == ParseStatus.NOT_PARSED
    assert parsed.parsed == _QWEN_BBOX_TEXT
    assert parsed.boxes is not None
    assert len(parsed.boxes) == 2
    assert parsed.boxes[0].x1 == 0.045
    assert parsed.boxes[0].label == "A dominant full-body front view of a woman in white dress."
    assert parsed.parse_errors == []


def test_free_text_without_bbox_parser_keeps_boxes_none() -> None:
    contract = OutputContract(mode=OutputMode.FREE_TEXT)
    parsed = parse_response("No boxes here", contract)

    assert parsed.boxes is None
    assert parsed.parse_errors == []


def test_soft_sections_with_bbox_parser_keeps_both_results() -> None:
    text = (
        "分类: 拼接图\n\n"
        "理由\n"
        "该图像由两张独立照片水平拼接而成\n"
        "bbox:[10,20,30,40]: extra annotation"
    )
    contract = _soft_contract(["分类", "理由"])
    contract.bbox_parser = BBoxParser(image_slot="image", preset="qwen_inline")
    parsed = parse_response(text, contract)

    assert parsed.parse_status == ParseStatus.PARSED
    # 主解析按原样保留文本；bbox 行作为理由区段内容的一部分被保留。
    assert parsed.parsed == {
        "分类": "拼接图",
        "理由": "该图像由两张独立照片水平拼接而成\nbbox:[10,20,30,40]: extra annotation",
    }
    assert parsed.boxes is not None
    assert len(parsed.boxes) == 1
    assert parsed.boxes[0].x1 == 0.010
    assert parsed.boxes[0].label == "extra annotation"
