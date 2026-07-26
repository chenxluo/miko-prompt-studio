"""Provider image limits are enforced before network I/O."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from app.adapters.openai_compat import OpenAICompatAdapter
from app.adapters.vertex import VertexAdapter
from app.schemas.common import AttemptStatus, ErrorType
from app.schemas.internal_request import InternalRequest, ModelSpec, RequestImage, SampleRef


def _request(model_id: str, image_count: int) -> InternalRequest:
    return InternalRequest(
        request_id="req_test",
        sample_ref=SampleRef(sample_id="s1"),
        model=ModelSpec(
            provider_id="openai_compat",
            model_id=model_id,
            adapter_id="openai_compat",
        ),
        images=[
            RequestImage(request_image_id=f"img{index}", order=index)
            for index in range(image_count)
        ],
    )


def test_execute_rejects_over_limit_before_network_io() -> None:
    cases = [
        (OpenAICompatAdapter(), "gpt-test", 20),
        (VertexAdapter(), "gemini-test", 16),
    ]
    for adapter, model_id, limit in cases:
        with (
            patch.object(adapter, "build_provider_request") as build,
            patch.object(adapter, "send") as send,
        ):
            result = asyncio.run(
                adapter.execute(_request(model_id, limit + 1), api_key="unused")
            )

        build.assert_not_called()
        send.assert_not_awaited()
        assert result.status == AttemptStatus.FAILED
        assert result.error is not None
        assert result.error.type == ErrorType.UNSUPPORTED_CAPABILITY
        assert result.error.retryable is False
        assert result.error.message == (
            f"Model {model_id!r} accepts at most {limit} images per request, "
            f"got {limit + 1}."
        )


def test_execute_stream_rejects_over_limit_before_network_io() -> None:
    adapter = OpenAICompatAdapter()
    with (
        patch.object(adapter, "build_provider_request") as build,
        patch.object(adapter, "stream") as stream,
    ):
        result = asyncio.run(
            adapter.execute_stream(_request("gpt-test", 21), api_key="unused")
        )

    build.assert_not_called()
    stream.assert_not_called()
    assert result.error is not None
    assert result.error.type == ErrorType.UNSUPPORTED_CAPABILITY


def test_execute_allows_exact_image_limit() -> None:
    adapter = OpenAICompatAdapter()
    with (
        patch.object(
            adapter,
            "build_provider_request",
            return_value={"model": "gpt-test"},
        ) as build,
        patch.object(adapter, "send", side_effect=RuntimeError("network sentinel")) as send,
    ):
        result = asyncio.run(adapter.execute(_request("gpt-test", 20), api_key="unused"))

    build.assert_called_once()
    send.assert_awaited_once()
    assert result.error is not None
    assert result.error.type != ErrorType.UNSUPPORTED_CAPABILITY
