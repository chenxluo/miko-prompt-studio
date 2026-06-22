"""One-shot integration tests against the FastAPI app without a live server.

Run with: python -m scripts.test_integration
"""

from __future__ import annotations

import asyncio
import base64
import tempfile
from pathlib import Path
from uuid import uuid4

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session_factory, init_db
from app.main import app
from app.models.prompt import PromptORM, PromptVersionORM
from app.models.result_snapshot import ResultSnapshotORM
from app.models.run import RunItemORM, RunSessionORM


async def run_tests():
    await init_db()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await _test_prompt_save(client)
        await _test_few_shot_with_image(client)
        await _test_result_snapshot_with_image(client)


async def _test_prompt_save(client: httpx.AsyncClient) -> None:
    payload = {
        "name": f"integration-test-{uuid4().hex[:8]}",
        "system_prompt": "sys",
        "user_template": "user",
        "format_instruction": "",
        "notes": "",
        "image_slot_specs": [],
        "few_shot_examples": [],
        "prompt_id": None,
    }
    response = await client.post("/api/prompts", json=payload)
    assert response.status_code == 200, f"save_prompt failed: {response.text}"
    data = response.json()
    assert data["created"] is True
    print(f"[OK] save_prompt -> {data['prompt_id']}")


async def _test_few_shot_with_image(client: httpx.AsyncClient) -> None:
    # Build a tiny inline PNG (1x1 red pixel)
    png_bytes = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c63686464606060000006062003b8d815020000000049454e44ae426082"
    )
    data_uri = f"data:image/png;base64,{base64.b64encode(png_bytes).decode()}"

    payload = {
        "name": f"few-shot-test-{uuid4().hex[:8]}",
        "system_prompt": "sys",
        "user_template": "user",
        "format_instruction": "",
        "notes": "",
        "image_slot_specs": [],
        "few_shot_examples": [
            {
                "example_id": f"ex_{uuid4().hex[:8]}",
                "title": "example",
                "enabled": True,
                "input_text": "input",
                "output_text": "output",
                "parsed_output": None,
                "reasoning_text": None,
                "images": [
                    {
                        "request_image_id": f"rimg_{uuid4().hex[:8]}",
                        "source_image_id": f"img_{uuid4().hex[:8]}",
                        "role": "target",
                        "path": None,
                        "mime_type": "image/png",
                        "order": 0,
                        "resolved": {
                            "uri": data_uri,
                            "mime_type": "image/png",
                            "width": 1,
                            "height": 1,
                        },
                    }
                ],
                "source_run_id": None,
                "source_run_item_id": None,
                "source_attempt_id": None,
                "notes": "",
                "created_from": "run_result",
            }
        ],
        "prompt_id": None,
    }
    response = await client.post("/api/prompts", json=payload)
    assert response.status_code == 200, f"save_prompt with image failed: {response.text}"
    data = response.json()
    prompt_id = data["prompt_id"]
    version_id = data["prompt_version_id"]

    # Verify the image file was persisted and example.images is now ImageRef.
    db = get_session_factory()
    async with db() as session:
        version = await session.scalar(
            select(PromptVersionORM).where(PromptVersionORM.prompt_version_id == version_id)
        )
        assert version is not None
        examples = version.few_shot_examples or []
        assert len(examples) == 1
        image_refs = examples[0].get("images") or []
        assert len(image_refs) == 1
        img_path = image_refs[0].get("path")
        assert img_path and Path(img_path).exists(), "few-shot image was not persisted"
        print(f"[OK] few-shot image persisted -> {img_path}")

    # Verify serving endpoint.
    filename = Path(img_path).name
    serve_resp = await client.get(f"/api/prompts/{prompt_id}/versions/{version_id}/images/{filename}")
    assert serve_resp.status_code == 200, f"serve prompt image failed: {serve_resp.status_code}"
    print("[OK] few-shot image served")


async def _test_result_snapshot_with_image(client: httpx.AsyncClient) -> None:
    png_bytes = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c63686464606060000006062003b8d815020000000049454e44ae426082"
    )
    data_uri = f"data:image/png;base64,{base64.b64encode(png_bytes).decode()}"

    db = get_session_factory()
    async with db() as session:
        run_id = f"run_{uuid4().hex[:12]}"
        run_item_id = f"ritem_{uuid4().hex[:12]}"
        session.add(
            RunSessionORM(
                run_id=run_id,
                run_type="lab",
                name="test-run",
                status="completed",
                source={},
                config_snapshot={"prompt_version": {"system_prompt": "sys", "user_template": "user"}},
                summary={},
            )
        )
        session.add(
            RunItemORM(
                run_item_id=run_item_id,
                run_id=run_id,
                sample_id=f"sample_{uuid4().hex[:8]}",
                status="success",
                internal_request_snapshot={
                    "images": [
                        {
                            "request_image_id": f"rimg_{uuid4().hex[:8]}",
                            "role": "target",
                            "resolved": {
                                "uri": data_uri,
                                "mime_type": "image/png",
                                "width": 1,
                                "height": 1,
                            },
                        }
                    ]
                },
                response={"raw_text": "ok"},
            )
        )
        await session.commit()

    payload = {
        "run_id": run_id,
        "run_item_id": run_item_id,
        "name": f"snapshot-test-{uuid4().hex[:8]}",
    }
    response = await client.post("/api/result-snapshots", json=payload)
    assert response.status_code == 200, f"create snapshot failed: {response.text}"
    data = response.json()
    snapshot_id = data["snapshot_id"]
    assert data["internal_request_snapshot"] is not None
    images = data["internal_request_snapshot"].get("images") or []
    assert len(images) == 1
    uri = images[0].get("uri")
    assert uri and uri.startswith(f"/api/result-snapshots/{snapshot_id}/images/")
    print(f"[OK] snapshot created -> {snapshot_id}, image uri -> {uri}")

    # Verify serving endpoint.
    filename = Path(uri).name
    serve_resp = await client.get(uri)
    assert serve_resp.status_code == 200, f"serve snapshot image failed: {serve_resp.status_code}"
    print("[OK] snapshot image served")

    # Verify DB row has image_dir and config_snapshot.
    async with db() as session:
        row = await session.scalar(
            select(ResultSnapshotORM).where(ResultSnapshotORM.snapshot_id == snapshot_id)
        )
        assert row is not None
        assert row.image_dir is not None
        assert row.config_snapshot is not None
        print("[OK] snapshot DB row has image_dir and config_snapshot")


if __name__ == "__main__":
    asyncio.run(run_tests())
    print("\nAll integration tests passed.")
