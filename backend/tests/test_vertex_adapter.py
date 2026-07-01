"""Vertex AI (Gemini) native adapter — unit tests.

Covers build structure (raw-base64 inlineData, systemInstruction gating),
JSON-output-contract (responseMimeType/responseSchema + UPPERCASE type mapping),
thinking-off vs thinking-on, parse_response finishReason + promptFeedback
mapping, parse_usage field mapping, service-account key validation, JWT
header/claims shape, and _endpoint URL building for stream/non-stream + region
extraction.

Uses only stdlib + app imports (mirrors test_adapter_thinking_params.py). No
network, no third-party imports here. A fixed RSA PKCS#8 service-account key is
embedded so the JWT round-trip signs against a real key (the ``cryptography``
call lives inside the adapter, not this file).
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from pathlib import Path
from typing import Any

# Make `app` importable when running this file directly: `python tests/...`.
# Mirrors backend/tests/conftest.py. stdlib-only; harmless under pytest.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters.vertex import (  # noqa: E402
    GEMINI_MODELS,
    VertexAdapter,
    _endpoint,
    _sanitize_gemini_schema,
    _service_account,
    _sign_jwt,
)
from app.schemas.common import AttemptStatus, ErrorType, OutputMode  # noqa: E402
from app.schemas.internal_request import (  # noqa: E402
    InternalRequest,
    ModelSpec,
    PromptSpec,
    RequestImage,
    ResolvedImage,
    SampleRef,
)
from app.schemas.model_config import ModelParameters  # noqa: E402
from app.schemas.output_contract import OutputContract  # noqa: E402
from app.schemas.run_record import StreamEvent  # noqa: E402

# A real 2048-bit RSA PKCS#8 private key (unencrypted). Used only so _sign_jwt
# can sign — never sent anywhere. Baked in to avoid importing cryptography here.
_PRIVATE_KEY_PEM = """-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDSHSpkcVWPYQ2Q
SK+UY+Je4YXSONvt5Jnzz69RcmMf0IgrxJDyYzOBsiCogZithfz4TepBgrWXokt8
4Wyl4sAPc0ENCab2jgD+EqETrgGqhAQ5zSHVNndtQdu0ubIzIf6OsGJMKfWokvEG
Nhx2s6URvfEJN5bFPIycZeGqo0LXKmwIdt1KcDgxL+VGlFPtrwIPsOhqt8xumSvS
9XO4aQh/wQXmefP03lDjdlE32lWyKfGcKk4OwsC3JoB9oGHQCCQxVIeUTyxyC6cW
ZX82b9j0yDLST7Hp7/4zy278FCKekznUsb/6EpSiwUJpLC6mIVEhSX6wOllrNley
A8qBU4M7AgMBAAECggEADPi7+0N78sQdIEE8hb685PqrVlUoTsGEN6ckvbSAJiCr
p3gVMsGpFmK23XBSyrOw8GtvAOhe6aOdYXJRUNR04v9Mjs9/vUz7BrSDuUFO3QYV
dLQTWKRqLxaXx8qHE90PaCO/jdAxWFzqAGYqz7E7iaLeVKFX74lTbPxlODGoGLxr
ERq6HkMFrQ5cVP7qguvcgXgAA76E4jvmFsVuQHSlTyseih/PoDqGSncRjJainas/
VP3HCm6fziUlrzxmGDoSuP8wGL2XWCc7LTs3WDW540b+KoQjvBx4RCx+eWlFSvOw
abfITp5x6KxPphhhKuBDw+enYAe6+r4FjDS8B8+PcQKBgQDyNik4eDUazTc73++L
MHoEDh7uZ2JS2QAvvVBpe6Aet8b2wfKAyhynjC3wtWmJk/C3pmFqu+Xxfq0myVTG
+gEcisUK+HHsukAXI6C1wwMlWhSRKrd8R2TtG140F0GTd91n4iemXCwmdmzyvxKD
b/0LgYVTZX8MbPhjJBM6QqjiRwKBgQDeEzvZp4NgM4CcByZlqjOi77IGbjr8w3vb
5ljsABz0K2nxc9m4Qgf8zEAmkuE4KwNhrhcXMZo7Xh/Ee9niKu2pLjjcaGFbMb90
1qaiAVcOZmILmoqG3Fx5dEADOFuwaxva+Di675m1+tYgLzk5nxVMksTY7mkb/YvD
D6FU3F39bQKBgDTtcup9EhWuPGCgGadPy4nxT/8Gpmy2MJ0+AEFcm2u6+wZW8VgF
UmemcS+FZO+EXXi0Kdt5/dBcvxeXrSfh37ZN+KriCXsSZAjqZybw21IhMhdav0ew
DjTl4xr87f58lewqdkGbKKarADm3WSNRqHkIL4s+xZmAgnKfonf7sw3nAoGALZbp
PH+FGuS3zFAzc7+DJjnq5CMQ/P7smHIrYxeK2h1nfGf6FDeKCD2uFb0lezBpW04v
81T9gp6KCv4Z9rI1Y/vXNHhBNEV8NnIydyOrSYt/KT6qnZDzcwOIeKDDQe5bI5K9
orK5bYB3INhQ+SFNcBDZVGdtMI/Wd07oIdGzgekCgYEAh2W89p/a9CfZadNEDhyW
VErQ7jBz7JUgerL+8yex/dZjna6WW9j1KK4xgGXvDK+0C+1TdqoJkZNH1NowN3Ii
wdNNKo/24nYbzza4a9O6CT/DEdoFQ/8Ne8lBgevusM9hc6QBnSOp/TAP0rQBKJcH
Ue+gUJxWpJ0JGhvBent3++k=
-----END PRIVATE KEY-----"""


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _request(
    *,
    params: ModelParameters | None = None,
    output_contract: OutputContract | None = None,
    images: list[RequestImage] | None = None,
    system_prompt: str = "",
    user_prompt: str = "hello",
) -> InternalRequest:
    return InternalRequest(
        request_id="req_test",
        sample_ref=SampleRef(sample_id="s1"),
        model=ModelSpec(
            provider_id="vertex",
            model_id="gemini-2.5-pro",
            parameters=params or ModelParameters(),
        ),
        prompt=PromptSpec(system_prompt=system_prompt, user_prompt=user_prompt),
        images=images or [],
        output_contract=output_contract or OutputContract(),
    )


def _sa_json() -> str:
    """A valid service-account JSON key built around the embedded RSA PEM."""

    return json.dumps(
        {
            "type": "service_account",
            "project_id": "my-proj-123",
            "private_key_id": "keyabc",
            "private_key": _PRIVATE_KEY_PEM,
            "client_email": "svc@my-proj-123.iam.gserviceaccount.com",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )


class _FakeResp:
    """Minimal stand-in for httpx.Response — parse_response only needs .json()."""

    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body

    def json(self) -> dict[str, Any]:
        return self._body


# ---------------------------------------------------------------------------
# 1. build_provider_request structure
# ---------------------------------------------------------------------------


def test_build_basic_structure_with_system_instruction() -> None:
    adapter = VertexAdapter()
    payload = adapter.build_provider_request(
        _request(system_prompt="be brief", user_prompt="hi")
    )

    assert payload["contents"] == [{"role": "user", "parts": [{"text": "hi"}]}]
    assert payload["systemInstruction"] == {"parts": [{"text": "be brief"}]}
    assert payload["__vertex_model"] == "gemini-2.5-pro"
    assert "stream" not in payload


def test_build_omits_system_instruction_when_empty() -> None:
    adapter = VertexAdapter()
    payload = adapter.build_provider_request(_request(system_prompt="   "))

    assert "systemInstruction" not in payload


def test_build_image_uses_raw_base64_inline_data() -> None:
    adapter = VertexAdapter()
    img = RequestImage(
        request_image_id="i1",
        order=0,
        resolved=ResolvedImage(uri="data:image/png;base64,AAAA", mime_type="image/png"),
    )
    payload = adapter.build_provider_request(_request(images=[img]))

    parts = payload["contents"][0]["parts"]
    # text part first, then inlineData with RAW base64 + mimeType sibling
    assert parts[0] == {"text": "hello"}
    assert parts[1] == {"inlineData": {"mimeType": "image/png", "data": "AAAA"}}
    # Must NOT be wrapped as a data: URI
    assert "data:" not in parts[1]["inlineData"]["data"]


def test_build_empty_prompt_and_no_images_emits_empty_text_part() -> None:
    adapter = VertexAdapter()
    payload = adapter.build_provider_request(_request(user_prompt=""))

    assert payload["contents"][0]["parts"] == [{"text": ""}]


def test_build_generation_config_camel_case() -> None:
    adapter = VertexAdapter()
    payload = adapter.build_provider_request(
        _request(
            params=ModelParameters(
                temperature=0.7, top_p=0.9, max_output_tokens=512, stop=["END"]
            )
        )
    )
    gc = payload["generationConfig"]
    assert gc["temperature"] == 0.7
    assert gc["topP"] == 0.9
    assert gc["maxOutputTokens"] == 512
    assert gc["stopSequences"] == ["END"]
    # No OpenAI-only fields leak in.
    assert "reasoning_effort" not in gc
    assert "enable_thinking" not in gc


# ---------------------------------------------------------------------------
# 2. JSON output contract
# ---------------------------------------------------------------------------


def test_build_loose_json_sets_response_mime_type() -> None:
    adapter = VertexAdapter()
    payload = adapter.build_provider_request(
        _request(output_contract=OutputContract(mode=OutputMode.LOOSE_JSON))
    )
    gc = payload["generationConfig"]
    assert gc["responseMimeType"] == "application/json"
    assert "responseSchema" not in gc


def test_build_strict_json_with_schema_uppercases_types() -> None:
    adapter = VertexAdapter()
    schema = {
        "type": "object",
        "$schema": "http://json-schema.org/draft-07/schema#",  # must be stripped
        "title": "drop me",
        "additionalProperties": False,
        "properties": {
            "label": {"type": "string", "description": "a label"},
            "count": {"type": "integer"},
            "score": {"type": "number"},
            "tags": {"type": "array", "items": {"type": "string"}},
            "active": {"type": "boolean"},
            "meta": {"type": "object", "properties": {"k": {"type": "string"}}},
        },
        "required": ["label"],
    }
    payload = adapter.build_provider_request(
        _request(
            output_contract=OutputContract(mode=OutputMode.STRICT_JSON, json_schema=schema)
        )
    )
    gc = payload["generationConfig"]
    assert gc["responseMimeType"] == "application/json"
    rs = gc["responseSchema"]
    # UPPERCASE proto enum names
    assert rs["type"] == "OBJECT"
    props = rs["properties"]
    assert props["label"]["type"] == "STRING"
    assert props["label"]["description"] == "a label"
    assert props["count"]["type"] == "INTEGER"
    assert props["score"]["type"] == "NUMBER"
    assert props["tags"]["type"] == "ARRAY"
    assert props["tags"]["items"]["type"] == "STRING"
    assert props["active"]["type"] == "BOOLEAN"
    assert props["meta"]["type"] == "OBJECT"
    assert rs["required"] == ["label"]
    # Disallowed keys dropped everywhere
    for key in ("$schema", "title", "additionalProperties"):
        assert key not in rs
        assert key not in props["label"]


def test_sanitize_gemini_schema_unknown_type_left_as_is() -> None:
    cleaned = _sanitize_gemini_schema({"type": "weirdtype", "description": "x"})
    assert cleaned is not None
    assert cleaned["type"] == "weirdtype"
    assert cleaned["description"] == "x"


def test_sanitize_gemini_schema_idempotent_uppercase() -> None:
    cleaned = _sanitize_gemini_schema({"type": "STRING"})
    assert cleaned["type"] == "STRING"


# ---------------------------------------------------------------------------
# 3. thinking-off vs thinking-on
# ---------------------------------------------------------------------------


def test_thinking_off_uses_budget_zero_without_include_thoughts() -> None:
    adapter = VertexAdapter()
    payload = adapter.build_provider_request(
        _request(params=ModelParameters(enable_thinking=False))
    )
    tc = payload["generationConfig"]["thinkingConfig"]
    assert tc == {"thinkingBudget": 0}
    assert "includeThoughts" not in tc


def test_thinking_on_with_budget_includes_thoughts_and_budget() -> None:
    adapter = VertexAdapter()
    payload = adapter.build_provider_request(
        _request(params=ModelParameters(enable_thinking=True, thinking_budget=2048))
    )
    tc = payload["generationConfig"]["thinkingConfig"]
    assert tc["includeThoughts"] is True
    assert tc["thinkingBudget"] == 2048


def test_thinking_default_omits_thinking_config() -> None:
    """Default (enable_thinking=None, no budget) must NOT emit thinkingConfig —
    a neutral default. Emitting it would force thought capture on every call
    (cost/behaviour shift) and 400 on Gemini 1.5, which lacks thinkingConfig."""
    adapter = VertexAdapter()
    payload = adapter.build_provider_request(_request())
    assert "thinkingConfig" not in payload.get("generationConfig", {})


def test_thinking_budget_only_emits_with_budget() -> None:
    """A bare thinking_budget (enable_thinking=None) opts into thinking."""
    adapter = VertexAdapter()
    payload = adapter.build_provider_request(
        _request(params=ModelParameters(thinking_budget=1024))
    )
    tc = payload["generationConfig"]["thinkingConfig"]
    assert tc["includeThoughts"] is True
    assert tc["thinkingBudget"] == 1024


# ---------------------------------------------------------------------------
# 4. parse_response
# ---------------------------------------------------------------------------


def test_parse_response_stop_succeeds() -> None:
    adapter = VertexAdapter()
    body = {
        "candidates": [
            {
                "content": {"role": "model", "parts": [{"text": "answer"}]},
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 3,
            "candidatesTokenCount": 5,
            "totalTokenCount": 8,
        },
    }
    result = adapter.parse_response(_FakeResp(body), _request())
    assert result.status == AttemptStatus.SUCCEEDED
    assert result.normalized_response is not None
    assert result.normalized_response.text == "answer"
    assert result.normalized_response.finish_reason == "STOP"
    assert result.error is None


def test_parse_response_separates_reasoning_from_text() -> None:
    adapter = VertexAdapter()
    body = {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [
                        {"text": "thinking...", "thought": True},
                        {"text": "visible"},
                    ],
                },
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "usageMetadata": {},
    }
    result = adapter.parse_response(_FakeResp(body), _request())
    assert result.normalized_response.text == "visible"
    assert result.normalized_response.reasoning_text == "thinking..."


def test_parse_response_safety_finish_reason_blocked() -> None:
    adapter = VertexAdapter()
    body = {
        "candidates": [
            {
                "content": {"role": "model", "parts": [{"text": ""}]},
                "finishReason": "SAFETY",
                "index": 0,
            }
        ],
        "usageMetadata": {},
    }
    result = adapter.parse_response(_FakeResp(body), _request())
    assert result.status == AttemptStatus.BLOCKED
    assert result.error is not None
    assert result.error.type == ErrorType.SAFETY_BLOCKED
    assert result.normalized_response is not None
    assert result.normalized_response.safety.blocked is True
    assert result.normalized_response.safety.categories == ["SAFETY"]


def test_parse_response_prompt_feedback_block_reason() -> None:
    adapter = VertexAdapter()
    body = {
        "candidates": [],
        "usageMetadata": {},
        "promptFeedback": {"blockReason": "SAFETY"},
    }
    result = adapter.parse_response(_FakeResp(body), _request())
    assert result.status == AttemptStatus.BLOCKED
    assert result.error is not None
    assert result.error.type == ErrorType.SAFETY_BLOCKED


def test_parse_response_empty_candidates_failed() -> None:
    adapter = VertexAdapter()
    body = {"candidates": [], "usageMetadata": {}}
    result = adapter.parse_response(_FakeResp(body), _request())
    assert result.status == AttemptStatus.FAILED
    assert result.error is not None
    assert result.error.type == ErrorType.EMPTY_RESPONSE


# ---------------------------------------------------------------------------
# 5. parse_usage
# ---------------------------------------------------------------------------


def test_parse_usage_maps_gemini_fields_with_metadata() -> None:
    adapter = VertexAdapter()
    usage = adapter.parse_usage(
        {
            "usageMetadata": {
                "promptTokenCount": 10,
                "candidatesTokenCount": 20,
                "totalTokenCount": 30,
                "cachedContentTokenCount": 4,
                "thoughtsTokenCount": 2,
            }
        }
    )
    assert usage.input_tokens == 10
    assert usage.output_tokens == 20
    assert usage.total_tokens == 30
    assert usage.cached_input_tokens == 4
    assert usage.provider_reported is True
    assert usage.estimated is False
    assert usage.raw_usage is not None
    # thoughtsTokenCount surfaced for display and folded into the billable
    # output count (billed at output price; candidatesTokenCount excludes it).
    assert usage.raw_usage["thoughtsTokenCount"] == 2
    assert usage.reasoning_tokens == 2
    assert usage.billable_output_tokens == 22  # 20 candidates + 2 thoughts


def test_parse_usage_stream_form_via_usage_key() -> None:
    adapter = VertexAdapter()
    usage = adapter.parse_usage({"usage": {"promptTokenCount": 7, "candidatesTokenCount": 3}})
    assert usage.input_tokens == 7
    assert usage.output_tokens == 3
    assert usage.total_tokens == 10  # fallback to input+output
    assert usage.provider_reported is True


def test_parse_usage_empty_estimated() -> None:
    adapter = VertexAdapter()
    usage = adapter.parse_usage({})
    assert usage.input_tokens == 0
    assert usage.estimated is True
    assert usage.provider_reported is False
    assert usage.raw_usage is None


# ---------------------------------------------------------------------------
# 6. service-account key validation
# ---------------------------------------------------------------------------


def test_service_account_valid() -> None:
    sa = _service_account(_sa_json())
    assert sa["project_id"] == "my-proj-123"
    assert sa["client_email"].endswith(".iam.gserviceaccount.com")


def test_service_account_rejects_non_json() -> None:
    try:
        _service_account("not json")
    except ValueError:
        return
    raise AssertionError("expected ValueError for non-JSON input")


def test_service_account_rejects_missing_fields() -> None:
    bad = json.dumps({"type": "service_account", "project_id": "x"})
    try:
        _service_account(bad)
    except ValueError:
        return
    raise AssertionError("expected ValueError for missing fields")


def test_service_account_rejects_wrong_type() -> None:
    obj = json.loads(_sa_json())
    obj["type"] = "external_account"
    try:
        _service_account(json.dumps(obj))
    except ValueError:
        return
    raise AssertionError("expected ValueError for non-service-account type")


# ---------------------------------------------------------------------------
# 7. JWT header/claims shape (no network call)
# ---------------------------------------------------------------------------


def test_sign_jwt_header_and_claims() -> None:
    sa = _service_account(_sa_json())
    assertion = _sign_jwt(sa)

    header_b64, claims_b64, signature_b64 = assertion.split(".")

    def _pad(s: str) -> str:
        return s + "=" * (-len(s) % 4)

    header = json.loads(base64.urlsafe_b64decode(_pad(header_b64)))
    claims = json.loads(base64.urlsafe_b64decode(_pad(claims_b64)))

    assert header["alg"] == "RS256"
    assert header["typ"] == "JWT"
    assert header["kid"] == sa["private_key_id"]
    assert claims["iss"] == sa["client_email"]
    assert claims["aud"] == sa["token_uri"]
    assert claims["scope"] == "https://www.googleapis.com/auth/cloud-platform"
    assert claims["exp"] - claims["iat"] == 3600
    # Signature segment is non-empty base64url and decodes
    assert signature_b64
    assert base64.urlsafe_b64decode(_pad(signature_b64))


# ---------------------------------------------------------------------------
# 8. _endpoint URL building + region extraction
# ---------------------------------------------------------------------------


def test_endpoint_non_stream_default_region() -> None:
    url = _endpoint(None, "my-proj", "gemini-2.5-pro", stream=False)
    assert url == (
        "https://us-central1-aiplatform.googleapis.com/v1beta1/"
        "projects/my-proj/locations/us-central1/"
        "publishers/google/models/gemini-2.5-pro:generateContent"
    )


def test_endpoint_stream_suffix() -> None:
    url = _endpoint("us-central1", "my-proj", "gemini-2.5-pro", stream=True)
    assert url.endswith(":streamGenerateContent?alt=sse")


def test_endpoint_extracts_region_from_full_url() -> None:
    url = _endpoint(
        "https://europe-west4-aiplatform.googleapis.com", "p", "m", stream=False
    )
    assert url.startswith("https://europe-west4-aiplatform.googleapis.com/")
    assert "/locations/europe-west4/" in url


def test_endpoint_accepts_plain_region_string() -> None:
    url = _endpoint("asia-northeast1", "p", "m", stream=False)
    assert "/locations/asia-northeast1/" in url

def test_endpoint_global_uses_bare_host() -> None:
    """`global` locations are served by the bare host aiplatform.googleapis.com
    — a `global-aiplatform` subdomain does NOT exist and returns Google's HTML
    404. Path still keeps locations/global. Regression for the 404 bug."""
    url = _endpoint("global", "my-proj", "gemini-3.0-pro-preview", stream=True)
    assert url == (
        "https://aiplatform.googleapis.com/v1beta1/"
        "projects/my-proj/locations/global/"
        "publishers/google/models/gemini-3.0-pro-preview"
        ":streamGenerateContent?alt=sse"
    )


# ---------------------------------------------------------------------------
# Discovery smoke (static catalog + key validation)
# ---------------------------------------------------------------------------


def test_list_and_capability() -> None:
    adapter = VertexAdapter()
    assert set(adapter.list_models()) == set(GEMINI_MODELS)
    cap = adapter.get_capability("gemini-2.5-pro")
    assert cap.provider_id == "vertex"
    assert cap.supports_image is True
    assert cap.supports_multi_image is True
    assert cap.supports_system_prompt is True
    assert cap.supports_json_mode is True
    assert cap.supports_strict_json_schema is False
    assert cap.max_images == 16


# ---------------------------------------------------------------------------
# Streaming SSE parser (offline) — happy-path delta/usage shape
# ---------------------------------------------------------------------------


async def _aiter(lines: list[str]):
    for line in lines:
        yield line


async def _collect(adapter: VertexAdapter, lines: list[str]) -> list[StreamEvent]:
    out: list[StreamEvent] = []
    async for ev in adapter._events_from_sse_lines(_aiter(lines)):
        out.append(ev)
    return out


def test_events_from_sse_lines() -> None:
    adapter = VertexAdapter()
    lines = [
        'data: {"candidates":[{"content":{"parts":[{"text":"hel"}]},"finishReason":"STOP"}]}',
        'data: {"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1}}',
        "",
        ": heartbeat",
    ]
    events = asyncio.run(_collect(adapter, lines))
    assert [e.event for e in events] == ["content", "usage", "done"]
    assert events[0].delta == "hel"
    assert events[1].usage["candidatesTokenCount"] == 1
    assert events[2].finish_reason == "STOP"


def test_events_from_sse_lines_reasoning_delta() -> None:
    adapter = VertexAdapter()
    lines = [
        'data: {"candidates":[{"content":{"parts":[{"text":"hm","thought":true}]}}]}',
    ]
    events = asyncio.run(_collect(adapter, lines))
    assert events[0].event == "reasoning"
    assert events[0].delta == "hm"


if __name__ == "__main__":
    test_build_basic_structure_with_system_instruction()
    test_build_omits_system_instruction_when_empty()
    test_build_image_uses_raw_base64_inline_data()
    test_build_empty_prompt_and_no_images_emits_empty_text_part()
    test_build_generation_config_camel_case()
    test_build_loose_json_sets_response_mime_type()
    test_build_strict_json_with_schema_uppercases_types()
    test_sanitize_gemini_schema_unknown_type_left_as_is()
    test_sanitize_gemini_schema_idempotent_uppercase()
    test_thinking_off_uses_budget_zero_without_include_thoughts()
    test_thinking_on_with_budget_includes_thoughts_and_budget()
    test_thinking_default_omits_thinking_config()
    test_thinking_budget_only_emits_with_budget()
    test_parse_response_stop_succeeds()
    test_parse_response_separates_reasoning_from_text()
    test_parse_response_safety_finish_reason_blocked()
    test_parse_response_prompt_feedback_block_reason()
    test_parse_response_empty_candidates_failed()
    test_parse_usage_maps_gemini_fields_with_metadata()
    test_parse_usage_stream_form_via_usage_key()
    test_parse_usage_empty_estimated()
    test_service_account_valid()
    test_service_account_rejects_non_json()
    test_service_account_rejects_missing_fields()
    test_service_account_rejects_wrong_type()
    test_sign_jwt_header_and_claims()
    test_endpoint_non_stream_default_region()
    test_endpoint_stream_suffix()
    test_endpoint_extracts_region_from_full_url()
    test_endpoint_accepts_plain_region_string()
    test_endpoint_global_uses_bare_host()
    test_list_and_capability()
    test_events_from_sse_lines()
    test_events_from_sse_lines_reasoning_delta()
    print("ok")
