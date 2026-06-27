from app.schemas.common import OutputMode, ParseStatus
from app.schemas.output_contract import OutputContract, ParserConfig
from app.services.parser_engine import parse_response


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
