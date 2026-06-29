"""build_provider_request must not emit thinking-effort params when thinking
is explicitly disabled.

Regression test for the bug where ``enable_thinking=False`` was sent alongside
``reasoning_effort`` (a value left over in the Lab store from a previous
thinking-on session). Qwen3 treats the presence of ``reasoning_effort`` as an
implicit thinking-on signal, overriding ``enable_thinking=false`` and producing
an unwanted reasoning chain that blows past ``max_tokens``.
"""

from app.adapters.openai_compat import OpenAICompatAdapter
from app.schemas.internal_request import InternalRequest, ModelSpec, SampleRef
from app.schemas.model_config import ModelParameters


def _request(params: ModelParameters) -> InternalRequest:
    return InternalRequest(
        request_id="req_test",
        sample_ref=SampleRef(sample_id="s1"),
        model=ModelSpec(
            provider_id="openai_compat",
            model_id="qwen3.5-flash",
            parameters=params,
        ),
    )


def test_thinking_off_suppresses_effort_and_budget() -> None:
    """enable_thinking=False must drop reasoning_effort / thinking_budget."""
    adapter = OpenAICompatAdapter()
    params = ModelParameters(
        enable_thinking=False,
        reasoning_effort="low",
        thinking_budget=1024,
        max_output_tokens=2048,
    )

    payload = adapter.build_provider_request(_request(params))

    assert payload["enable_thinking"] is False
    assert "reasoning_effort" not in payload
    assert "thinking_budget" not in payload


def test_thinking_on_emits_effort_and_budget() -> None:
    """enable_thinking=True keeps the effort / budget params."""
    adapter = OpenAICompatAdapter()
    params = ModelParameters(
        enable_thinking=True,
        reasoning_effort="low",
        thinking_budget=1024,
    )

    payload = adapter.build_provider_request(_request(params))

    assert payload["enable_thinking"] is True
    assert payload["reasoning_effort"] == "low"
    assert payload["thinking_budget"] == 1024


def test_thinking_default_omits_enable_thinking_but_keeps_effort() -> None:
    """enable_thinking=None (provider default) still forwards effort params so a
    user who only set reasoning_effort isn't silently dropped."""
    adapter = OpenAICompatAdapter()
    params = ModelParameters(
        enable_thinking=None,
        reasoning_effort="high",
    )

    payload = adapter.build_provider_request(_request(params))

    assert "enable_thinking" not in payload
    assert payload["reasoning_effort"] == "high"


if __name__ == "__main__":
    test_thinking_off_suppresses_effort_and_budget()
    test_thinking_on_emits_effort_and_budget()
    test_thinking_default_omits_enable_thinking_but_keeps_effort()
    print("ok")
