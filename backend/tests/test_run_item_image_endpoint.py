"""End-to-end test for the run-item image serving endpoint.

Verifies the Step B contract: a run_item whose ``internal_request_snapshot``
rewrites its inline image URI to ``/api/run-items/{id}/images/{i}`` (so the
snapshot stays small) still displays the image, served from the persisted
upload file via the endpoint.
"""
import json

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.database import get_engine

_BASE_TS = "2026-01-01T00:00:00+00:00"


async def _seed_run_item_with_image(client, run_item_id: str, image_path: str) -> None:
    engine = get_engine()
    snapshot = {
        "images": [
            {
                "path": image_path,
                "mime_type": "image/png",
                "role": "target",
                "resolved": {"uri": f"/api/run-items/{run_item_id}/images/0"},
            }
        ],
        "prompt": {"user_prompt": "hi"},
    }
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO run_sessions (run_id, run_type, name, status, started_at, "
                "source, config_snapshot, summary, notes, created_at, updated_at) "
                "VALUES (:rid, 'lab', 'img-test', 'completed', :ts, '{}', '{}', '{}', '', :ts, :ts)"
            ),
            {"rid": f"run_for_{run_item_id}", "ts": _BASE_TS},
        )
        await conn.execute(
            text(
                "INSERT INTO run_items (run_item_id, run_id, sample_id, status, "
                "internal_request_snapshot, response, usage, cost, review, estimated_cost, "
                "created_at, updated_at) VALUES (:iid, :rid, :sid, 'succeeded', :snap, "
                "'{}', '{}', '{}', '{}', 0, :ts, :ts)"
            ),
            {
                "iid": run_item_id,
                "rid": f"run_for_{run_item_id}",
                "sid": "s1",
                "snap": json.dumps(snapshot),
                "ts": _BASE_TS,
            },
        )


def test_run_item_image_endpoint_serves_referenced_file(
    client: TestClient, tmp_path
) -> None:
    # A real (tiny) image file on disk, standing in for an upload.
    image_file = tmp_path / "input.png"
    image_file.write_bytes(b"\x89PNG\r\n\x1a\n" + b"payload-bytes")

    import asyncio

    run_item_id = "ritem_img_test_1"
    asyncio.run(_seed_run_item_with_image(client, run_item_id, str(image_file)))

    resp = client.get(f"/api/run-items/{run_item_id}/images/0")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("image/png")
    assert resp.content.startswith(b"\x89PNG")
    assert b"payload-bytes" in resp.content

    # Out-of-range index and unknown item are 404.
    assert client.get(f"/api/run-items/{run_item_id}/images/9").status_code == 404
    assert client.get("/api/run-items/ritem_missing/images/0").status_code == 404
