import asyncio
import json

from app.adapters.openai_compat import OpenAICompatAdapter
from app.schemas.common import AttemptStatus
from app.schemas.internal_request import InternalRequest, ModelSpec, SampleRef


async def _lines(items: list[str]):
    for item in items:
        yield item


async def _collect_events(lines: list[str]):
    adapter = OpenAICompatAdapter()
    return [event async for event in adapter._events_from_sse_lines(_lines(lines))]


def test_openai_compat_sse_parser_yields_reasoning_content_usage_and_done() -> None:
    lines = [
        "data: "
        + json.dumps({"choices": [{"delta": {"reasoning_content": "think "}}]}),
        "data: " + json.dumps({"choices": [{"delta": {"content": "hello"}}]}),
        "data: " + json.dumps({"usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}, "choices": []}),
        "data: [DONE]",
    ]

    events = asyncio.run(_collect_events(lines))

    assert [event.event for event in events] == ["reasoning", "content", "usage", "done"]
    assert events[0].delta == "think "
    assert events[1].delta == "hello"
    assert events[2].usage == {
        "prompt_tokens": 3,
        "completion_tokens": 2,
        "total_tokens": 5,
    }


async def _stream_to_result(lines: list[str]):
    adapter = OpenAICompatAdapter()
    request = InternalRequest(
        request_id="req_stream_test",
        sample_ref=SampleRef(sample_id="sample_stream_test"),
        model=ModelSpec(provider_id="openai_compat", model_id="test-model"),
    )
    return await adapter.stream_to_result(
        adapter._events_from_sse_lines(_lines(lines)),
        request,
    )


def test_openai_compat_stream_to_result_accumulates_adapter_result() -> None:
    lines = [
        "data: " + json.dumps({"choices": [{"delta": {"reasoning_content": "a"}}]}),
        "data: " + json.dumps({"choices": [{"delta": {"reasoning_content": "b"}}]}),
        "data: " + json.dumps({"choices": [{"delta": {"content": "he"}}]}),
        "data: " + json.dumps({"choices": [{"delta": {"content": "llo"}}]}),
        "data: " + json.dumps({"usage": {"prompt_tokens": 4, "completion_tokens": 5, "total_tokens": 9}, "choices": []}),
        "data: [DONE]",
    ]

    result = asyncio.run(_stream_to_result(lines))

    assert result.status == AttemptStatus.SUCCEEDED
    assert result.normalized_response is not None
    assert result.normalized_response.text == "hello"
    assert result.normalized_response.reasoning_text == "ab"
    assert result.usage is not None
    assert result.usage.input_tokens == 4
    assert result.usage.output_tokens == 5
    assert result.usage.total_tokens == 9
