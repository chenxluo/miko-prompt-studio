import pytest
from fastapi.testclient import TestClient

from app.schemas.prompt import ImageSlotSpec
from app.schemas.sample_record import ImageRef, SampleRecord
from app.services.prompt_renderer import (
    extract_variable_specs,
    render_prompt,
    render_template_with_conditionals,
)


def test_extract_variable_specs_finds_user_system_and_conditional_vars() -> None:
    specs = extract_variable_specs(
        "Describe {{vars.title}} {{sample.sample_id}} {{metadata.source}} "
        "{{#vars.caption}}Caption: {{vars.caption}}{{/vars.caption}}",
        "System {{vars.tone}}",
    )

    by_id = {spec.var_id: spec for spec in specs}
    assert list(by_id) == ["tone", "title", "caption"]
    assert by_id["tone"].required is True
    assert by_id["title"].label == "title"
    assert by_id["caption"].type == "string"


def test_extract_variable_specs_marks_only_conditional_vars_optional() -> None:
    specs = extract_variable_specs(
        "{{#vars.optional_hint}}Hint {{vars.optional_hint}}{{/vars.optional_hint}} "
        "{{^vars.empty_case}}Fallback{{/vars.empty_case}} "
        "Always {{vars.required_name}} {{#vars.required_name}}again{{/vars.required_name}}"
    )

    by_id = {spec.var_id: spec for spec in specs}
    assert by_id["optional_hint"].required is False
    assert by_id["empty_case"].required is False
    assert by_id["required_name"].required is True


def test_render_template_with_conditionals_handles_truthy_and_falsy_blocks() -> None:
    rendered = render_template_with_conditionals(
        "A{{#vars.name}} {{vars.name}}{{/vars.name}}"
        "{{^vars.missing}} fallback{{/vars.missing}}"
        "{{^vars.count}} zero{{/vars.count}}",
        {"vars": {"name": "Miko", "count": 0}},
    )

    assert rendered == "A Miko fallback zero"


def test_missing_vars_still_resolve_to_empty_string() -> None:
    sample = SampleRecord(sample_id="sample_1", vars={"name": "Miko"})

    prompt = render_prompt(
        "Hello {{vars.name}} {{vars.missing}} {{#vars.missing}}nope{{/vars.missing}}",
        "System {{vars.absent}}",
        sample,
    )

    assert prompt.user_prompt == "Hello Miko  "
    assert prompt.system_prompt == "System "


def test_render_prompt_preserves_image_tokens_in_variable_values() -> None:
    sample = SampleRecord(
        sample_id="sample_images",
        vars={"context_prompt": "first {{image:0}} then {{image:1}}"},
    )

    prompt = render_prompt("Inspect {{vars.context_prompt}}", "", sample)

    assert prompt.user_prompt == "Inspect first {{image:0}} then {{image:1}}"


def test_render_prompt_expands_slot_images_with_absolute_indexes() -> None:
    sample = SampleRecord(
        sample_id="sample_each",
        images=[
            ImageRef(image_id="other", role="other", order=0),
            ImageRef(image_id="context_2", role="context", order=3),
            ImageRef(image_id="context_1", role="context", order=1),
            ImageRef(image_id="context_3", role="context", order=2),
        ],
    )
    prompt = render_prompt(
        "{{#each images.context_images}}Image {{number}}={{image}};{{/each}}",
        "",
        sample,
        [ImageSlotSpec(slot_id="context_images", role_hint="context", max_count=None)],
    )

    assert prompt.user_prompt == (
        "Image 1={{image:1}};Image 2={{image:2}};Image 3={{image:3}};"
    )


@pytest.mark.parametrize(
    ("template", "message"),
    [
        ("{{#each images.unknown}}{{image}}{{/each}}", "unknown image slot 'unknown'"),
        ("{{#each images.context_images}}{{image}}", "unmatched image each block"),
        (
            "{{#each images.context_images}}"
            "{{#each images.context_images}}{{image}}{{/each}}"
            "{{/each}}",
            "nested image each block",
        ),
    ],
)
def test_render_prompt_rejects_invalid_image_each(template: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        render_prompt(
            template,
            "",
            SampleRecord(sample_id="bad"),
            [ImageSlotSpec(slot_id="context_images", max_count=None)],
        )


def test_render_prompt_rejects_image_each_in_system_prompt() -> None:
    with pytest.raises(ValueError, match="only allowed in user_template"):
        render_prompt(
            "plain",
            "{{#each images.context_images}}{{image}}{{/each}}",
            SampleRecord(sample_id="bad_system"),
            [ImageSlotSpec(slot_id="context_images", max_count=None)],
        )


def test_prompt_round_trip_excludes_variable_specs(client: TestClient) -> None:
    response = client.post(
        "/api/prompts",
        json={
            "name": "Prompt Contract",
            "system_prompt": "Use {{vars.tone}}",
            "user_template": "Describe {{vars.title}}",
        },
    )
    assert response.status_code == 200, response.text
    created = response.json()
    assert created["created"] is True
    assert "prompt_version_id" not in created

    fetched = client.get(f"/api/prompts/{created['prompt_id']}")
    assert fetched.status_code == 200, fetched.text
    data = fetched.json()
    assert data["system_prompt"] == "Use {{vars.tone}}"
    assert data["user_template"] == "Describe {{vars.title}}"
    assert "variable_specs" not in data
    assert "versions" not in data

    updated = client.post(
        "/api/prompts",
        json={
            "prompt_id": created["prompt_id"],
            "name": "Prompt Contract",
            "system_prompt": "Use concise tone",
            "user_template": "Summarize {{vars.title}}",
            "notes": "overwritten",
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json() == {"prompt_id": created["prompt_id"], "created": False}

    fetched_again = client.get(f"/api/prompts/{created['prompt_id']}")
    assert fetched_again.status_code == 200, fetched_again.text
    data = fetched_again.json()
    assert data["system_prompt"] == "Use concise tone"
    assert data["user_template"] == "Summarize {{vars.title}}"
    assert data["notes"] == "overwritten"
