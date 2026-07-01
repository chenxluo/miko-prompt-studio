"""Cost estimation helpers."""

from __future__ import annotations

from app.schemas.pricing import CostBreakdown, CostEstimate, PricingSnapshot
from app.schemas.run_record import Usage


def calculate_cost(usage: Usage, pricing: PricingSnapshot) -> CostEstimate:
    """Calculate itemized request cost from usage and a pricing snapshot."""

    discount = pricing.batch_discount
    cached_tokens = usage.cached_input_tokens or 0
    billable_input_tokens = max(usage.input_tokens - cached_tokens, 0)

    input_text = billable_input_tokens * pricing.input_token_price / 1_000_000
    # Bill reasoning/thinking tokens at the OUTPUT price. Providers where
    # output_tokens already includes reasoning (OpenAI completion_tokens) leave
    # billable_output_tokens None (no double-bill); providers where reasoning
    # is separate (Vertex: candidatesTokenCount excludes thoughtsTokenCount)
    # set it to output_tokens + reasoning_tokens.
    billable_output = (
        usage.billable_output_tokens
        if usage.billable_output_tokens is not None
        else usage.output_tokens
    )
    output_text = billable_output * pricing.output_token_price / 1_000_000
    cached_price = pricing.cached_input_price or pricing.input_token_price
    cached_input = cached_tokens * cached_price / 1_000_000
    image_input = _image_cost(usage, pricing)

    breakdown = CostBreakdown(
        input_text=input_text * discount,
        output_text=output_text * discount,
        image_input=image_input * discount,
        cached_input=cached_input * discount,
        retry_extra=0.0,
    )
    total = sum(
        (
            breakdown.input_text,
            breakdown.output_text,
            breakdown.image_input,
            breakdown.cached_input,
            breakdown.retry_extra,
        )
    )
    return CostEstimate(
        estimated_cost=total,
        currency=pricing.currency,
        pricing_profile_id=pricing.pricing_profile_id,
        pricing_snapshot=pricing,
        cost_breakdown=breakdown,
    )


def estimate_batch_cost(usage_list: list[Usage], pricing: PricingSnapshot) -> CostEstimate:
    """Aggregate a list of request usages into one cost estimate."""

    total_breakdown = CostBreakdown()
    for usage in usage_list:
        estimate = calculate_cost(usage, pricing)
        total_breakdown.input_text += estimate.cost_breakdown.input_text
        total_breakdown.output_text += estimate.cost_breakdown.output_text
        total_breakdown.image_input += estimate.cost_breakdown.image_input
        total_breakdown.cached_input += estimate.cost_breakdown.cached_input
        total_breakdown.retry_extra += estimate.cost_breakdown.retry_extra

    total = sum(
        (
            total_breakdown.input_text,
            total_breakdown.output_text,
            total_breakdown.image_input,
            total_breakdown.cached_input,
            total_breakdown.retry_extra,
        )
    )
    return CostEstimate(
        estimated_cost=total,
        currency=pricing.currency,
        pricing_profile_id=pricing.pricing_profile_id,
        pricing_snapshot=pricing,
        cost_breakdown=total_breakdown,
    )


def _image_cost(usage: Usage, pricing: PricingSnapshot) -> float:
    image_pricing = pricing.image_pricing
    if image_pricing.mode == "token":
        return (usage.image_tokens or 0) * (image_pricing.image_token_price or 0.0) / 1_000_000
    if image_pricing.mode == "per_request":
        return usage.image_count * (image_pricing.image_per_request_price or 0.0)
    return 0.0
