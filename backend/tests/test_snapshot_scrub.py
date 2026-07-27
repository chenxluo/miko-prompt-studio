"""Unit tests for the snapshot image-byte scrubber and URI rewriter."""
from app.services.snapshot_scrub import (
    retarget_image_uris,
    rewrite_inline_image_uris,
    scrub_image_bytes,
)


def test_scrubs_data_uri_in_openai_image_url_structure() -> None:
    # The exact structure that leaked 13 MB per attempt for qwen/openai-compat.
    big = "data:image/jpeg;base64," + "A" * 5_000_000
    snap = {
        "model": "qwen3.5-flash",
        "messages": [
            {"role": "system", "content": "you are a helper"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe"},
                    {"type": "image_url", "image_url": {"url": big}},
                ],
            },
        ],
    }
    out = scrub_image_bytes(snap)
    url = out["messages"][1]["content"][1]["image_url"]["url"]
    assert url.startswith("data:image/jpeg;base64,<redacted")
    assert len(url) < 100
    # Non-image fields are untouched.
    assert out["model"] == "qwen3.5-flash"
    assert out["messages"][0]["content"] == "you are a helper"
    assert out["messages"][1]["content"][0]["text"] == "describe"
    # Input is not mutated.
    assert snap["messages"][1]["content"][1]["image_url"]["url"] == big


def test_scrubs_b64_json_and_data_keys() -> None:
    snap = {
        "b64_json": "B" * 100_000,
        "data": "C" * 100_000,
        "mimeType": "image/png",
    }
    out = scrub_image_bytes(snap)
    assert out["b64_json"].startswith("<redacted")
    # Generic "data" with image/png sibling → scrubbed.
    assert out["data"].startswith("<redacted")
    assert out["mimeType"] == "image/png"


def test_preserves_short_non_image_strings_and_urls() -> None:
    snap = {
        # A plain URL is not scrubbed here (secret-redaction handles tokens).
        "url": "https://example.com/img.png?token=secret",
        "role": "target",
        "mime_type": "image/jpeg",
        "path": "C:/uploads/abc",
        "transport_kind": "inline_data",
    }
    out = scrub_image_bytes(snap)
    assert out == snap  # nothing image-byte-shaped to scrub


def test_handles_nested_lists_and_none() -> None:
    assert scrub_image_bytes(None) is None
    assert scrub_image_bytes([1, "x", {"u": "data:image/png;base64,AAAA"}]) == [
        1,
        "x",
        {"u": "data:image/png;base64,<redacted 4-char base64>"},
    ]


def test_empty_and_unmatched_inputs_pass_through() -> None:
    assert scrub_image_bytes("") == ""
    assert scrub_image_bytes({}) == {}
    assert scrub_image_bytes("plain text") == "plain text"


def test_rewrite_replaces_inline_data_uri_with_serving_url() -> None:
    big = "data:image/jpeg;base64," + "A" * 2_000_000
    snap = {
        "images": [
            {
                "path": "C:/uploads/abc",
                "mime_type": "image/jpeg",
                "resolved": {"uri": big, "transport": "inline_data", "width": 100},
            }
        ],
        "prompt": {"user_prompt": "hi"},
    }
    out = rewrite_inline_image_uris(snap, "ritem_xyz")
    uri = out["images"][0]["resolved"]["uri"]
    assert uri == "/api/run-items/ritem_xyz/images/0"
    # The multi-MB payload is gone; surrounding metadata is kept.
    assert out["images"][0]["path"] == "C:/uploads/abc"
    assert out["images"][0]["resolved"]["width"] == 100
    assert len(str(out)) < 500
    # Input unchanged.
    assert snap["images"][0]["resolved"]["uri"] == big


def test_rewrite_skips_direct_urls_and_pathless_images() -> None:
    snap = {
        "images": [
            # Direct-transport URL: small, adapter-relevant → left alone.
            {"path": "C:/uploads/a", "resolved": {"uri": "https://x/y.png"}},
            # Inline data URI but no servable path → kept (can't serve it).
            {"resolved": {"uri": "data:image/png;base64,AAAA"}},
        ]
    }
    out = rewrite_inline_image_uris(snap, "ritem_1")
    assert out["images"][0]["resolved"]["uri"] == "https://x/y.png"
    assert out["images"][1]["resolved"]["uri"] == "data:image/png;base64,AAAA"


def test_retarget_repoints_serving_urls_to_new_run_item_id() -> None:
    snap = {
        "images": [
            {"resolved": {"uri": "/api/run-items/TEMP_ID/images/0"}},
            {"resolved": {"uri": "/api/run-items/TEMP_ID/images/1"}},
        ]
    }
    out = retarget_image_uris(snap, "TEMP_ID", "FINAL_ID")
    assert out["images"][0]["resolved"]["uri"] == "/api/run-items/FINAL_ID/images/0"
    assert out["images"][1]["resolved"]["uri"] == "/api/run-items/FINAL_ID/images/1"
    # Non-matching URIs untouched.
    snap2 = {"images": [{"resolved": {"uri": "https://elsewhere/x.png"}}]}
    assert retarget_image_uris(snap2, "TEMP_ID", "FINAL_ID") == snap2
