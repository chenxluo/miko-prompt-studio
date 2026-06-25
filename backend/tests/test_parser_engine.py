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
