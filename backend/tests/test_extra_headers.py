"""Tests for provider-config ``extra_headers``: header merge + API round-trip.

Covers the DashScope use case where a per-provider-config header
(``X-DashScope-DataInspection``) must ride along on every /chat/completions
call to disable 绿网 moderation.
"""

from app.adapters.openai_compat import OpenAICompatAdapter


def test_build_headers_merges_and_overrides_defaults():
    """Extra headers are added and win over built-in defaults."""

    adapter = OpenAICompatAdapter()

    # Baseline: only Content-Type + Authorization.
    base = adapter._build_headers("sk-test")
    assert base == {
        "Content-Type": "application/json",
        "Authorization": "Bearer sk-test",
    }

    # Extra headers are merged in.
    extras = {"X-DashScope-DataInspection": '{"input":"disable","output":"disable"}'}
    merged = adapter._build_headers("sk-test", extras)
    assert merged["X-DashScope-DataInspection"] == '{"input":"disable","output":"disable"}'
    assert merged["Content-Type"] == "application/json"
    assert merged["Authorization"] == "Bearer sk-test"

    # Extras override a built-in default when names collide.
    override = adapter._build_headers("sk-test", {"Authorization": "Token override"})
    assert override["Authorization"] == "Token override"

    # None / empty extras behave like the baseline.
    assert adapter._build_headers("sk-test", None) == base
    assert adapter._build_headers("sk-test", {}) == base

    # No key + extras still omits Authorization but keeps extras.
    no_key = adapter._build_headers(None, {"X-Debug": "1"})
    assert "Authorization" not in no_key
    assert no_key["X-Debug"] == "1"


def test_provider_config_extra_headers_round_trip(client):
    """extra_headers persists through POST (create + update) then GET."""

    headers = {"X-DashScope-DataInspection": '{"input":"disable","output":"disable"}'}
    create = client.post(
        "/api/provider-configs",
        json={
            "name": "DashScope",
            "adapter_id": "openai",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "api_key": "sk-test",
            "extra_headers": headers,
        },
    )
    assert create.status_code == 200, create.text
    created = create.json()
    assert created["extra_headers"] == headers
    assert created["created"] is True

    listing = client.get("/api/provider-configs")
    assert listing.status_code == 200
    matched = [
        r for r in listing.json() if r["provider_config_id"] == created["provider_config_id"]
    ]
    assert matched, "created provider config missing from listing"
    assert matched[0]["extra_headers"] == headers

    # Update path overwrites extra_headers.
    updated_headers = {"X-Custom": "v1"}
    update = client.post(
        "/api/provider-configs",
        json={
            "provider_config_id": created["provider_config_id"],
            "name": "DashScope",
            "adapter_id": "openai",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "extra_headers": updated_headers,
        },
    )
    assert update.status_code == 200, update.text
    assert update.json()["extra_headers"] == updated_headers
    assert update.json()["created"] is False
