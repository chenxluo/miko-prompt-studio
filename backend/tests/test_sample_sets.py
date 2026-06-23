import asyncio
import importlib
import json

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


def _import_csv(client: TestClient) -> str:
    mapping = {
        "id_column": "id",
        "sample_type": "single_image",
        "var_columns": ["prompt"],
        "metadata_columns": ["group"],
    }
    response = client.post(
        "/api/import/csv/file",
        files={"file": ("samples.csv", b"id,prompt,group\ns1,hello,a\ns2,world,b\n", "text/csv")},
        data={"delimiter": ",", "mapping": json.dumps(mapping)},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["imported_count"] == 2
    return data["sample_set_id"]


def test_csv_file_import_creates_sample_set_and_preview_matches_path_shape(
    client: TestClient,
) -> None:
    preview = client.post(
        "/api/import/csv/preview/file",
        files={"file": ("samples.csv", b"id,prompt\ns1,hello\ns2,world\n", "text/csv")},
        data={"delimiter": ","},
    )
    assert preview.status_code == 200, preview.text
    assert preview.json() == {
        "columns": ["id", "prompt"],
        "rows": [{"id": "s1", "prompt": "hello"}, {"id": "s2", "prompt": "world"}],
    }

    sample_set_id = _import_csv(client)
    detail = client.get(f"/api/sample-sets/{sample_set_id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["record_ids"] == ["s1", "s2"]


def test_jsonl_file_import_creates_sample_set_and_dedupes_record_ids(client: TestClient) -> None:
    body = b'\n'.join(
        [
            json.dumps(
                {"sample_id": "dup", "sample_type": "single_image", "vars": {"a": "1"}}
            ).encode(),
            json.dumps(
                {"sample_id": "dup", "sample_type": "single_image", "vars": {"a": "2"}}
            ).encode(),
            json.dumps({"sample_type": "single_image", "vars": {"a": "3"}}).encode(),
        ]
    )
    response = client.post(
        "/api/import/jsonl/file",
        files={"file": ("samples.jsonl", body, "application/x-ndjson")},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["imported_count"] == 3

    detail = client.get(f"/api/sample-sets/{data['sample_set_id']}")
    assert detail.status_code == 200, detail.text
    record_ids = detail.json()["record_ids"]
    assert len(record_ids) == 3
    assert len(set(record_ids)) == 3
    assert record_ids[0] == "dup"
    assert record_ids[1].startswith("dup_")
    assert record_ids[2].startswith("sr_")


def test_sample_set_detail_returns_contract(client: TestClient) -> None:
    sample_set_id = _import_csv(client)
    response = client.get(f"/api/sample-sets/{sample_set_id}")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["sample_set_id"] == sample_set_id
    assert data["name"]
    assert data["description"] == ""
    assert data["record_ids"] == ["s1", "s2"]
    assert data["metadata"] == {}
    assert data["created_at"]


def test_sample_set_delete_removes_set_and_records(client: TestClient) -> None:
    sample_set_id = _import_csv(client)

    response = client.delete(f"/api/sample-sets/{sample_set_id}")
    assert response.status_code == 200, response.text
    assert response.json() == {"deleted": True}

    assert client.get(f"/api/sample-sets/{sample_set_id}").status_code == 404
    samples = client.get(f"/api/samples?sample_set_id={sample_set_id}")
    assert samples.status_code == 200, samples.text
    assert samples.json() == []
