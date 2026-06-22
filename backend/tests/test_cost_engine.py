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
