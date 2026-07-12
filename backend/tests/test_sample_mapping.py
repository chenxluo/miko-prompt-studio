
from app.schemas.prompt import ImageSlotSpec, VariableSpec
from app.schemas.sample_record import ImageRef, SampleRecord
from app.services.contract_validation import validate_sample_against_specs
from app.services.sample_mapping import apply_sample_mapping


def test_variable_mapping_works() -> None:
    sample = SampleRecord(sample_id="s1", vars={"old_name": "value"})
    mapped = apply_sample_mapping(sample, variable_mapping={"new_name": "old_name"})
    assert mapped.vars["new_name"] == "value"
    assert mapped.vars["old_name"] == "value"


def test_image_role_mapping_works() -> None:
    sample = SampleRecord(
        sample_id="s1",
        images=[ImageRef(image_id="i1", role="source")],
    )
    mapped = apply_sample_mapping(sample, image_role_mapping={"target": "source"})
    assert mapped.images[0].role == "target"


def test_combined_mapping_works() -> None:
    sample = SampleRecord(
        sample_id="s1",
        vars={"src_var": "hello"},
        images=[ImageRef(image_id="i1", role="src_role")],
    )
    mapped = apply_sample_mapping(
        sample,
        variable_mapping={"task_var": "src_var"},
        image_role_mapping={"task_role": "src_role"},
    )
    assert mapped.vars["task_var"] == "hello"
    assert mapped.vars["src_var"] == "hello"
    assert mapped.images[0].role == "task_role"


def test_identity_mapping_leaves_sample_unchanged() -> None:
    sample = SampleRecord(
        sample_id="s1",
        vars={"a": 1},
        images=[ImageRef(image_id="i1", role="target")],
    )
    mapped = apply_sample_mapping(sample, {}, {})
    assert mapped is sample


def test_missing_required_fields_still_raise_validation_errors_after_mapping() -> None:
    sample = SampleRecord(
        sample_id="s1",
        vars={"src_var": ""},
    )
    variable_specs = [VariableSpec(var_id="task_var", required=True)]
    errors = validate_sample_against_specs(
        sample,
        image_slot_specs=[],
        variable_specs=variable_specs,
        variable_mapping={"task_var": "src_var"},
    )
    assert any("task_var" in error for error in errors)


def test_unmapped_fields_are_preserved() -> None:
    sample = SampleRecord(
        sample_id="s1",
        vars={"a": 1, "b": 2},
        images=[
            ImageRef(image_id="i1", role="role_a"),
            ImageRef(image_id="i2", role="role_b"),
        ],
    )
    mapped = apply_sample_mapping(
        sample,
        variable_mapping={"task_a": "a"},
        image_role_mapping={"task_a": "role_a"},
    )
    assert mapped.vars == {"a": 1, "b": 2, "task_a": 1}
    assert mapped.images[0].role == "task_a"
    assert mapped.images[1].role == "role_b"


def test_validation_after_image_role_mapping() -> None:
    sample = SampleRecord(
        sample_id="s1",
        images=[ImageRef(image_id="i1", role="source")],
    )
    image_slot_specs = [ImageSlotSpec(slot_id="s1", role_hint="target", required=True)]
    errors = validate_sample_against_specs(
        sample,
        image_slot_specs=image_slot_specs,
        variable_specs=[],
        image_role_mapping={"target": "source"},
    )
    assert errors == []
