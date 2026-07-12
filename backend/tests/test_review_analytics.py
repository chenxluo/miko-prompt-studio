"""Tests for the cross-run review-summary analytics endpoint.

Exercises POST /api/analytics/review-summary across variant/model/provider
groupings, the judged-denominator pass_rate, null avg_rating, rating_dist
shape, the empty-run_ids short-circuit, and the cross-run variant invariant
(two ordinary runs sharing a model_id must stay distinct variant rows).
"""

import asyncio

from fastapi.testclient import TestClient

RUN_IDS = ["rc", "rp1", "rp2"]


async def _seed_runs() -> None:
    from app.database import get_session_factory
    from app.models.run import RunItemORM, RunSessionORM

    session_factory = get_session_factory()
    async with session_factory() as db:
        db.add_all(
            [
                RunSessionORM(
                    run_id="rc",
                    run_type="lab",
                    name="Compare",
                    status="completed",
                    source={"task_version_id": "tv_cmp"},
                ),
                RunSessionORM(
                    run_id="rp1",
                    run_type="batch",
                    name="Plain One",
                    status="completed",
                    source={},
                ),
                RunSessionORM(
                    run_id="rp2",
                    run_type="batch",
                    name="Plain Two",
                    status="completed",
                    source={},
                ),
            ]
        )
        db.add_all(
            [
                # Compare run "rc": items carry compare_axes (config_label / task_version_id).
                RunItemORM(
                    run_item_id="c1", run_id="rc", sample_id="s1", status="succeeded",
                    model_id="gpt-4o", provider_id="openai",
                    accepted=1, rating=5, compare_axes={"config_label": "expA"},
                ),
                RunItemORM(
                    run_item_id="c2", run_id="rc", sample_id="s2", status="succeeded",
                    model_id="gpt-4o", provider_id="openai",
                    accepted=1, rating=4, compare_axes={"config_label": "expA"},
                ),
                RunItemORM(
                    run_item_id="c3", run_id="rc", sample_id="s3", status="succeeded",
                    model_id="gpt-4o", provider_id="openai",
                    accepted=0, rating=2, compare_axes={"config_label": "expA"},
                ),
                RunItemORM(
                    run_item_id="c4", run_id="rc", sample_id="s4", status="succeeded",
                    model_id="gpt-4o", provider_id="openai",
                    accepted=None, rating=3, compare_axes={"config_label": "expA"},
                ),
                RunItemORM(
                    run_item_id="c5", run_id="rc", sample_id="s5", status="succeeded",
                    model_id="claude", provider_id="anthropic",
                    accepted=1, rating=4, compare_axes={"task_version_id": "tv_axes"},
                ),
                RunItemORM(
                    run_item_id="c6", run_id="rc", sample_id="s6", status="succeeded",
                    model_id=None, provider_id=None,
                    accepted=None, rating=None, compare_axes={"config_label": "expC"},
                ),
                # Ordinary run "rp1": no compare_axes -> variant falls back to run name.
                RunItemORM(
                    run_item_id="p1a", run_id="rp1", sample_id="s7", status="succeeded",
                    model_id="gpt-4o", provider_id="openai",
                    accepted=1, rating=5, compare_axes=None,
                ),
                RunItemORM(
                    run_item_id="p1b", run_id="rp1", sample_id="s8", status="succeeded",
                    model_id="gpt-4o", provider_id="openai",
                    accepted=0, rating=1, compare_axes=None,
                ),
                # Ordinary run "rp2": same model as rp1, must stay a distinct variant row.
                RunItemORM(
                    run_item_id="p2a", run_id="rp2", sample_id="s9", status="succeeded",
                    model_id="gpt-4o", provider_id="openai",
                    accepted=1, rating=None, compare_axes=None,
                ),
                RunItemORM(
                    run_item_id="p2b", run_id="rp2", sample_id="s10", status="succeeded",
                    model_id="gpt-4o", provider_id="openai",
                    accepted=None, rating=None, compare_axes=None,
                ),
            ]
        )
        await db.commit()


def _seed() -> None:
    asyncio.run(_seed_runs())


def _rows_by_key(data: dict) -> dict:
    return {row["key"]: row for row in data["rows"]}


def test_group_by_variant(client: TestClient) -> None:
    _seed()
    resp = client.post(
        "/api/analytics/review-summary",
        json={"run_ids": RUN_IDS, "group_by": "variant"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["group_by"] == "variant"
    assert data["total_items"] == 10

    rows = data["rows"]
    # Sorted by n desc.
    assert [r["n"] for r in rows] == [4, 2, 2, 1, 1]
    assert rows[0]["key"] == "expA"

    by_key = _rows_by_key(data)
    assert by_key["expA"] == {
        "key": "expA", "model_display": "gpt-4o", "n": 4,
        "accepted": 2, "rejected": 1, "undecided": 1,
        "pass_rate": 2 / 3, "avg_rating": 3.5, "rating_count": 4,
        "rating_dist": [0, 1, 1, 1, 1],
    }
    # compare_axes.task_version_id rung (no config_label present).
    assert by_key["tv_axes"] == {
        "key": "tv_axes", "model_display": "claude", "n": 1,
        "accepted": 1, "rejected": 0, "undecided": 0,
        "pass_rate": 1.0, "avg_rating": 4.0, "rating_count": 1,
        "rating_dist": [0, 0, 0, 1, 0],
    }
    # Bucket with no model -> "—" display, no judgements, no ratings.
    assert by_key["expC"] == {
        "key": "expC", "model_display": "—", "n": 1,
        "accepted": 0, "rejected": 0, "undecided": 1,
        "pass_rate": None, "avg_rating": None, "rating_count": 0,
        "rating_dist": [0, 0, 0, 0, 0],
    }
    assert by_key["Plain One"] == {
        "key": "Plain One", "model_display": "gpt-4o", "n": 2,
        "accepted": 1, "rejected": 1, "undecided": 0,
        "pass_rate": 0.5, "avg_rating": 3.0, "rating_count": 2,
        "rating_dist": [1, 0, 0, 0, 1],
    }
    assert by_key["Plain Two"] == {
        "key": "Plain Two", "model_display": "gpt-4o", "n": 2,
        "accepted": 1, "rejected": 0, "undecided": 1,
        "pass_rate": 1.0, "avg_rating": None, "rating_count": 0,
        "rating_dist": [0, 0, 0, 0, 0],
    }

    # Cross-run invariant: rp1/rp2 share model gpt-4o but stay distinct variants.
    assert by_key["Plain One"]["model_display"] == "gpt-4o"
    assert by_key["Plain Two"]["model_display"] == "gpt-4o"


def test_group_by_model(client: TestClient) -> None:
    _seed()
    resp = client.post(
        "/api/analytics/review-summary",
        json={"run_ids": RUN_IDS, "group_by": "model"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["group_by"] == "model"
    assert data["total_items"] == 10

    rows = data["rows"]
    assert [r["n"] for r in rows] == [8, 1, 1]
    assert rows[0]["key"] == "gpt-4o"

    by_key = _rows_by_key(data)
    # gpt-4o collapses rc + rp1 + rp2 items into one row (contrast with variant split).
    assert by_key["gpt-4o"] == {
        "key": "gpt-4o", "model_display": "gpt-4o", "n": 8,
        "accepted": 4, "rejected": 2, "undecided": 2,
        "pass_rate": 4 / 6, "avg_rating": 3.3, "rating_count": 6,
        "rating_dist": [1, 1, 1, 1, 2],
    }
    assert by_key["claude"] == {
        "key": "claude", "model_display": "claude", "n": 1,
        "accepted": 1, "rejected": 0, "undecided": 0,
        "pass_rate": 1.0, "avg_rating": 4.0, "rating_count": 1,
        "rating_dist": [0, 0, 0, 1, 0],
    }
    assert by_key["unknown"] == {
        "key": "unknown", "model_display": "—", "n": 1,
        "accepted": 0, "rejected": 0, "undecided": 1,
        "pass_rate": None, "avg_rating": None, "rating_count": 0,
        "rating_dist": [0, 0, 0, 0, 0],
    }


def test_group_by_provider(client: TestClient) -> None:
    _seed()
    resp = client.post(
        "/api/analytics/review-summary",
        json={"run_ids": RUN_IDS, "group_by": "provider"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["group_by"] == "provider"
    assert data["total_items"] == 10

    rows = data["rows"]
    assert [r["n"] for r in rows] == [8, 1, 1]
    assert rows[0]["key"] == "openai"

    by_key = _rows_by_key(data)
    assert by_key["openai"] == {
        "key": "openai", "model_display": "gpt-4o", "n": 8,
        "accepted": 4, "rejected": 2, "undecided": 2,
        "pass_rate": 4 / 6, "avg_rating": 3.3, "rating_count": 6,
        "rating_dist": [1, 1, 1, 1, 2],
    }
    assert by_key["anthropic"] == {
        "key": "anthropic", "model_display": "claude", "n": 1,
        "accepted": 1, "rejected": 0, "undecided": 0,
        "pass_rate": 1.0, "avg_rating": 4.0, "rating_count": 1,
        "rating_dist": [0, 0, 0, 1, 0],
    }
    assert by_key["unknown"] == {
        "key": "unknown", "model_display": "—", "n": 1,
        "accepted": 0, "rejected": 0, "undecided": 1,
        "pass_rate": None, "avg_rating": None, "rating_count": 0,
        "rating_dist": [0, 0, 0, 0, 0],
    }


def test_default_group_by_is_variant(client: TestClient) -> None:
    _seed()
    resp = client.post("/api/analytics/review-summary", json={"run_ids": RUN_IDS})
    assert resp.status_code == 200
    data = resp.json()
    assert data["group_by"] == "variant"
    assert set(_rows_by_key(data)) == {"expA", "tv_axes", "expC", "Plain One", "Plain Two"}


def test_pass_rate_excludes_undecided(client: TestClient) -> None:
    _seed()
    resp = client.post(
        "/api/analytics/review-summary",
        json={"run_ids": RUN_IDS, "group_by": "variant"},
    )
    by_key = _rows_by_key(resp.json())

    # expA: accepted=2, rejected=1, undecided=1 -> judged=3 -> 2/3 (not 2/4).
    expA = by_key["expA"]
    assert (expA["accepted"], expA["rejected"], expA["undecided"]) == (2, 1, 1)
    assert expA["pass_rate"] == 2 / 3

    # Plain Two: accepted=1, rejected=0, undecided=1 -> judged=1 -> 1.0 (not 1/2).
    assert by_key["Plain Two"]["pass_rate"] == 1.0

    # expC: no judgements -> null.
    assert by_key["expC"]["pass_rate"] is None


def test_avg_rating_null_and_rating_dist_shape(client: TestClient) -> None:
    _seed()
    resp = client.post(
        "/api/analytics/review-summary",
        json={"run_ids": RUN_IDS, "group_by": "variant"},
    )
    data = resp.json()
    by_key = _rows_by_key(data)

    # No ratings -> null avg_rating and zero count.
    assert by_key["Plain Two"]["avg_rating"] is None
    assert by_key["Plain Two"]["rating_count"] == 0
    assert by_key["expC"]["avg_rating"] is None

    # rating_dist is always length 5 across every row.
    for row in data["rows"]:
        assert len(row["rating_dist"]) == 5

    # Index mapping: 1-star count lives at index 0.
    assert by_key["Plain One"]["rating_dist"] == [1, 0, 0, 0, 1]


def test_empty_run_ids(client: TestClient) -> None:
    _seed()
    resp = client.post("/api/analytics/review-summary", json={"run_ids": []})
    assert resp.status_code == 200
    assert resp.json() == {"group_by": "variant", "total_items": 0, "rows": []}

    # group_by is still echoed back on the empty short-circuit.
    resp2 = client.post(
        "/api/analytics/review-summary", json={"run_ids": [], "group_by": "model"}
    )
    assert resp2.json() == {"group_by": "model", "total_items": 0, "rows": []}


async def _seed_out_of_range() -> None:
    from app.database import get_session_factory
    from app.models.run import RunItemORM, RunSessionORM

    session_factory = get_session_factory()
    async with session_factory() as db:
        db.add(RunSessionORM(run_id="rx", run_type="lab", name="X", status="completed", source={}))
        db.add_all(
            [
                RunItemORM(
                    run_item_id="r1", run_id="rx", sample_id="s1", status="succeeded",
                    model_id="m1", provider_id="p1", accepted=1, rating=5, compare_axes=None,
                ),
                RunItemORM(
                    run_item_id="r2", run_id="rx", sample_id="s2", status="succeeded",
                    model_id="m1", provider_id="p1", accepted=1, rating=6, compare_axes=None,
                ),
                RunItemORM(
                    run_item_id="r3", run_id="rx", sample_id="s3", status="succeeded",
                    model_id="m1", provider_id="p1", accepted=0, rating=0, compare_axes=None,
                ),
            ]
        )
        await db.commit()


def test_rating_dist_excludes_out_of_range(client: TestClient) -> None:
    asyncio.run(_seed_out_of_range())
    resp = client.post(
        "/api/analytics/review-summary",
        json={"run_ids": ["rx"], "group_by": "variant"},
    )
    assert resp.status_code == 200
    row = _rows_by_key(resp.json())["X"]
    # Every non-None rating feeds sum/count (5 + 6 + 0 = 11 over 3)...
    assert row["rating_count"] == 3
    assert row["avg_rating"] == round(11 / 3, 1)  # 3.7
    # ...but only the in-range int (5) lands in the dist.
    assert row["rating_dist"] == [0, 0, 0, 0, 1]


def test_invalid_group_by_rejected(client: TestClient) -> None:
    resp = client.post(
        "/api/analytics/review-summary",
        json={"run_ids": ["rc"], "group_by": "nonsense"},
    )
    assert resp.status_code == 422
