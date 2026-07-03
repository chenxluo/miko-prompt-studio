"""Regression tests for the human review PATCH endpoint.

Covers the three bugs that made review "systematically broken":
  * missing ``labels`` field raised AttributeError on every PATCH,
  * ``is not None`` / truthy guards ignored explicit null/empty clears
    (Pending reset, star clear, notes clear),
  * in-place mutation + reassigning the same dict skipped SQLAlchemy's
    JSON dirty-tracking, so edits did not persist.
"""

import asyncio

from fastapi.testclient import TestClient


async def _seed() -> None:
    from app.database import get_session_factory
    from app.models.run import RunItemORM, RunSessionORM

    factory = get_session_factory()
    async with factory() as db:
        db.add(
            RunSessionORM(
                run_id="run_rev",
                run_type="lab",
                name="Review Run",
                status="completed",
                summary={},
            )
        )
        db.add(
            RunItemORM(
                run_item_id="ritem_rev_1",
                run_id="run_rev",
                sample_id="s1",
                status="succeeded",
                response={},
                review={},
            )
        )
        await db.commit()


def test_review_patch_applies_and_clears(client: TestClient) -> None:
    asyncio.run(_seed())
    base = "/api/runs/run_rev/items/ritem_rev_1"

    def patch(payload: dict) -> dict:
        r = client.patch(f"{base}/review", json=payload)
        assert r.status_code == 200, r.text
        return r.json()

    # Accept.
    assert patch({"accepted": True})["accepted"] is True
    # Explicit null resets to pending (was silently skipped before the fix).
    assert patch({"accepted": None})["accepted"] is None
    # Reject.
    assert patch({"accepted": False})["accepted"] is False

    # Rating then clear.
    assert patch({"rating": 4})["rating"] == 4
    assert patch({"rating": None})["rating"] is None

    # Notes then clear to empty string (was skipped because '' is falsy).
    assert patch({"notes": "looks good"})["notes"] == "looks good"
    assert patch({"notes": ""})["notes"] == ""

    # Labels (the field that used to crash the handler) round-trips.
    assert patch({"labels": ["good", "concise"]})["labels"] == ["good", "concise"]
    # Empty labels list clears stored labels.
    assert patch({"labels": []})["labels"] == []

    # Omitted fields must NOT clobber existing review state (PATCH semantics):
    # only rating is touched here, accepted from the prior write stays False.
    body = patch({"rating": 5})
    assert body["rating"] == 5
    assert body["accepted"] is False

    # Persistence: a fresh GET re-reads committed data, proving the JSON
    # column was actually written (the SQLAlchemy mutation-tracking fix).
    detail = client.get(base).json()
    assert detail["review"]["rating"] == 5
    assert detail["review"]["accepted"] is False
    assert detail["review"]["notes"] == ""
    assert "reviewed_at" in detail["review"]


def test_review_patch_unknown_run_item_returns_404(client: TestClient) -> None:
    r = client.patch(
        "/api/runs/run_rev/items/does_not_exist/review",
        json={"accepted": True},
    )
    assert r.status_code == 404
