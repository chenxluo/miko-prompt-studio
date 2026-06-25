import asyncio
import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MIKO_DATA_DIR", str(tmp_path))

    import app.config as config
    import app.database as database

    config._settings = None
    database._engine = None
    database._session_factory = None

    import app.main as main

    main = importlib.reload(main)
    with TestClient(main.app) as test_client:
        yield test_client

    engine = database.get_engine()
    asyncio.run(engine.dispose())
    database._engine = None
    database._session_factory = None
    config._settings = None


def _provider(client: TestClient) -> str:
    response = client.post(
        "/api/provider-configs",
        json={"name": "input-spec-provider", "adapter_id": "openai", "api_key": "sk-test"},
    )
    assert response.status_code == 200, response.text
    return response.json()["provider_config_id"]


IMAGE_SPECS = [
    {
        "slot_id": "front_slot",
        "role_hint": "front",
        "label": "Front image",
        "description": "Primary view",
        "required": True,
        "min_count": 1,
        "max_count": 1,
    },
    {
        "slot_id": "detail_slot",
        "role_hint": "detail",
        "label": "Detail images",
        "description": "Optional detail views",
        "required": False,
        "min_count": 0,
        "max_count": 3,
    },
]

VARIABLE_SPECS = [
    {
        "var_id": "title",
        "label": "Title",
        "description": "Object title",
        "type": "string",
        "required": True,
        "default_value": "",
    },
    {
        "var_id": "optional_hint",
        "label": "Hint",
        "description": "Optional annotation hint",
        "type": "string",
        "required": False,
        "default_value": "focus on defects",
    },
]


def _task(client: TestClient, provider_config_id: str) -> dict:
    response = client.post(
        "/api/tasks",
        json={
            "name": "Input Spec Task",
            "description": "Generate specs for importers",
            "version": {
                "system_prompt": "You are a careful image annotator.",
                "user_template": "Compare {{vars.title}} with {{vars.optional_hint}}.",
                "provider_config_id": provider_config_id,
                "model_id": "test-model",
                "model_parameters": {"temperature": 0.2},
                "output_contract": {"mode": "strict_json"},
                "image_preprocess_config": {"enabled": False},
                "image_slot_specs": IMAGE_SPECS,
                "variable_specs": VARIABLE_SPECS,
                "notes": "stored task version notes",
            },
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _input_spec(client: TestClient) -> dict:
    provider_config_id = _provider(client)
    task = _task(client, provider_config_id)
    task_version_id = task["current_version"]["task_version_id"]

    response = client.get(f"/api/tasks/{task['task_id']}/versions/{task_version_id}/input-spec")
    assert response.status_code == 200, response.text
    return response.json()


def test_input_spec_endpoint_returns_expected_structure(client: TestClient) -> None:
    spec = _input_spec(client)

    assert spec["task_id"].startswith("task_")
    assert spec["task_version_id"].startswith("tv_")
    assert spec["task_name"] == "Input Spec Task"
    assert spec["version_label"] == "v1"
    assert spec["system_prompt"] == "You are a careful image annotator."
    assert spec["user_template"] == "Compare {{vars.title}} with {{vars.optional_hint}}."
    assert len(spec["image_slots"]) == 2
    assert len(spec["variable_slots"]) == 2
    assert isinstance(spec["notes"], str)


def test_input_spec_examples_include_contract_columns(client: TestClient) -> None:
    spec = _input_spec(client)

    expected_columns = {column["column"]: column for column in spec["expected_csv_columns"]}
    assert set(expected_columns) == {
        "image_front",
        "image_detail",
        "var_title",
        "var_optional_hint",
    }
    assert expected_columns["image_front"]["kind"] == "image"
    assert expected_columns["image_front"]["role_hint"] == "front"
    assert expected_columns["var_title"]["kind"] == "variable"
    assert expected_columns["var_title"]["var_id"] == "title"

    csv_row = spec["csv_example_row"]
    assert csv_row["sample_id"] == "sample_001"
    assert csv_row["image_front"] == "path/to/front.jpg"
    assert csv_row["image_detail"].startswith("path/to/detail_1.jpg;")
    assert csv_row["var_title"] == "example_title"
    assert csv_row["var_optional_hint"] == "focus on defects"

    jsonl = spec["jsonl_example"]
    assert jsonl["sample_id"] == "sample_001"
    assert {image["role"] for image in jsonl["images"]} == {"front", "detail"}
    assert jsonl["vars"] == {
        "title": "example_title",
        "optional_hint": "focus on defects",
    }


def test_input_spec_reflects_required_and_optional_slots(client: TestClient) -> None:
    spec = _input_spec(client)

    images = {slot["slot_id"]: slot for slot in spec["image_slots"]}
    assert images["front_slot"]["required"] is True
    assert images["front_slot"]["min_count"] == 1
    assert images["front_slot"]["max_count"] == 1
    assert images["detail_slot"]["required"] is False
    assert images["detail_slot"]["min_count"] == 0
    assert images["detail_slot"]["max_count"] == 3

    variables = {slot["var_id"]: slot for slot in spec["variable_slots"]}
    assert variables["title"]["required"] is True
    assert variables["title"]["default_value"] == ""
    assert variables["optional_hint"]["required"] is False
    assert variables["optional_hint"]["default_value"] == "focus on defects"

    expected_columns = {column["column"]: column for column in spec["expected_csv_columns"]}
    assert expected_columns["image_front"]["required"] is True
    assert expected_columns["image_detail"]["required"] is False
    assert expected_columns["var_title"]["required"] is True
    assert expected_columns["var_optional_hint"]["required"] is False
