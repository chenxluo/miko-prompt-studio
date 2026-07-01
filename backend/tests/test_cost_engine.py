from math import isclose

from app.schemas.pricing import ImagePriceMode, PricingSnapshot
from app.schemas.run_record import Usage
from app.services.cost_engine import calculate_cost


def test_calculate_cost_uses_per_million_token_prices() -> None:
    usage = Usage(
        input_tokens=1_000_000,
        output_tokens=500_000,
        image_count=1,
        image_tokens=1_000_000,
        cached_input_tokens=100_000,
    )
    pricing = PricingSnapshot(
        pricing_profile_id="pricing-test",
        currency="USD",
        input_token_price=2.0,
        output_token_price=10.0,
        cached_input_price=0.5,
        image_pricing=ImagePriceMode(mode="token", image_token_price=3.0),
    )

    estimate = calculate_cost(usage, pricing)

    assert estimate.cost_breakdown.input_text == 1.8
    assert estimate.cost_breakdown.output_text == 5.0
    assert estimate.cost_breakdown.cached_input == 0.05
    assert estimate.cost_breakdown.image_input == 3.0
    assert isclose(estimate.estimated_cost, 9.85)


def test_calculate_cost_bills_reasoning_at_output_price_without_double_billing() -> None:
    """Vertex: candidatesTokenCount excludes thoughtsTokenCount, so
    billable_output_tokens must fold thinking in (billed at output price).
    OpenAI: completion_tokens already includes reasoning, so leaving
    billable_output_tokens None must NOT double-bill."""
    pricing = PricingSnapshot(
        pricing_profile_id="t", input_token_price=1.0, output_token_price=2.0
    )

    # Vertex-style: 36 visible + 1308 thinking (the user's 1183/36/2527 case).
    vertex_usage = Usage(
        input_tokens=1_183,
        output_tokens=36,
        total_tokens=2_527,
        reasoning_tokens=1_308,
        billable_output_tokens=36 + 1_308,
    )
    est = calculate_cost(vertex_usage, pricing)
    assert isclose(est.cost_breakdown.input_text, 1_183 * 1.0 / 1_000_000)
    # billable output = 1344 (36 + 1308) at output price
    assert isclose(est.cost_breakdown.output_text, 1_344 * 2.0 / 1_000_000)

    # OpenAI-style: output_tokens already includes reasoning → no override.
    openai_usage = Usage(
        input_tokens=100,
        output_tokens=500,  # includes 100 reasoning
        reasoning_tokens=100,
    )
    est2 = calculate_cost(openai_usage, pricing)
    assert isclose(est2.cost_breakdown.output_text, 500 * 2.0 / 1_000_000)
