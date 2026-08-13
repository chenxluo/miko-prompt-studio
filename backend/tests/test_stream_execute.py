"""Regression: BaseAdapter.execute_stream must thread request + extra_headers.

A past edit dropped the ``request`` positional when calling
``_result_from_stream_events``; FakeAdapter-based tests never hit the real
base-class streaming path, so it shipped broken.
"""

from __future__ import annotations

from app.adapters.openai_compat import OpenAICompatAdapter
from app.schemas.internal_request import InternalRequest, ModelSpec, RuntimeOptions, SampleRef
from app.schemas.model_config import ModelParameters
from app.schemas.run_record import StreamEvent

XH = {"X-DashScope-DataInspection": '{"input":"disable","output":"disable"}'}


def _request() -> InternalRequest:
    return InternalRequest(
        request_id="r1",
        sample_ref=SampleRef(sample_id="s1", sample_set_id="ss1"),
        model=ModelSpec(
            provider_id="dashscope", model_id="qwen-plus", parameters=ModelParameters()
        ),
        runtime=RuntimeOptions(timeout_seconds=30),
    )


async def test_execute_stream_accumulates_content_and_passes_headers():
    adapter = OpenAICompatAdapter()
    captured: dict = {}

    async def fake_stream(pr, api_key, base_url, timeout, extra_headers=None):
        captured["extra_headers"] = extra_headers
        yield StreamEvent(event="content", delta="hello ")
        yield StreamEvent(event="content", delta="world")
        yield StreamEvent(event="done", finish_reason="stop")

    adapter.stream = fake_stream

    result = await adapter.execute_stream(
        request=_request(),
        api_key="sk-test",
        base_url="https://dashscope.example/v1",
        timeout=30,
        extra_headers=XH,
    )

    assert captured["extra_headers"] == XH
    assert result.status.value == "succeeded"
    assert result.normalized_response.text == "hello world"


async def test_execute_stream_without_extra_headers():
    adapter = OpenAICompatAdapter()

    async def fake_stream(pr, api_key, base_url, timeout, extra_headers=None):
        yield StreamEvent(event="content", delta="ok")
        yield StreamEvent(event="done", finish_reason="stop")

    adapter.stream = fake_stream

    result = await adapter.execute_stream(
        request=_request(),
        api_key="sk-test",
        base_url="https://dashscope.example/v1",
        timeout=30,
    )

    assert result.status.value == "succeeded"
    assert result.normalized_response.text == "ok"
