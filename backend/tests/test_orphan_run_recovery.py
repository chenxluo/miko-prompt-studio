"""Regression: runs orphaned by a crashed/killed backend process must be swept
to a terminal state on the next startup, not left perpetually "running".

The matrix/compare executors track active runs in process-local memory; when
the process dies the in-memory task vanishes and ``_finalize_worker`` never
runs. ``_reap_orphaned_runs`` (called from ``init_db``) is the recovery.
"""
import json

from sqlalchemy import text

from app.database import _reap_orphaned_runs, get_engine

_BASE_TS = "2026-01-01T00:00:00+00:00"


async def _insert_orphan(client, *, run_id: str, item_statuses: list[str]) -> None:
    """Insert a fake orphaned run session + items directly into the DB."""
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO run_sessions (run_id, run_type, name, status, started_at, "
                "source, config_snapshot, summary, notes, created_at, updated_at) "
                "VALUES (:rid, 'batch', 'orphan', 'running', :ts, "
                "'{}', '{}', '{}', '', :ts, :ts)"
            ),
            {"rid": run_id, "ts": _BASE_TS},
        )
        for i, status in enumerate(item_statuses):
            await conn.execute(
                text(
                    "INSERT INTO run_items (run_item_id, run_id, sample_id, status, "
                    "response, usage, cost, review, estimated_cost, created_at, updated_at) "
                    "VALUES (:iid, :rid, :sid, :status, '{}', '{}', '{}', '{}', 0, :ts, :ts)"
                ),
                {
                    "iid": f"{run_id}_item_{i}",
                    "rid": run_id,
                    "sid": f"{run_id}_sample_{i}",
                    "status": status,
                    "ts": _BASE_TS,
                },
            )


async def _insert_terminal(client, *, run_id: str, session_status: str) -> None:
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO run_sessions (run_id, run_type, name, status, started_at, "
                "source, config_snapshot, summary, notes, created_at, updated_at) "
                "VALUES (:rid, 'batch', :name, :status, :ts, '{}', '{}', '{}', '', :ts, :ts)"
            ),
            {"rid": run_id, "name": run_id, "status": session_status, "ts": _BASE_TS},
        )
        await conn.execute(
            text(
                "INSERT INTO run_items (run_item_id, run_id, sample_id, status, "
                "response, usage, cost, review, estimated_cost, created_at, updated_at) "
                "VALUES (:iid, :rid, :sid, 'succeeded', '{}', '{}', '{}', '{}', 0, :ts, :ts)"
            ),
            {"iid": f"{run_id}_i", "rid": run_id, "sid": f"{run_id}_s", "ts": _BASE_TS},
        )


async def _statuses(client, run_id: str) -> tuple[str, list[tuple[str, dict | None]]]:
    engine = get_engine()
    async with engine.begin() as conn:
        sess = await conn.execute(
            text("SELECT status FROM run_sessions WHERE run_id = :rid"), {"rid": run_id}
        )
        session_status = sess.scalar()
        items = await conn.execute(
            text("SELECT status, error FROM run_items WHERE run_id = :rid ORDER BY run_item_id"),
            {"rid": run_id},
        )
        rows = [(r[0], json.loads(r[1]) if r[1] else None) for r in items.fetchall()]
    return session_status, rows


async def test_reap_marks_orphaned_running_session_and_its_items_failed(client) -> None:
    await _insert_orphan(client, run_id="run_orphan_a", item_statuses=["running", "pending"])

    engine = get_engine()
    async with engine.begin() as conn:
        await _reap_orphaned_runs(conn)

    session_status, items = await _statuses(client, "run_orphan_a")
    assert session_status == "failed"
    assert [status for status, _ in items] == ["failed", "failed"]
    # Error is explanatory and flagged retryable so "retry failed" can re-run it.
    for _status, error in items:
        assert error["type"] == "unknown_error"
        assert "interrupted" in error["message"].lower()
        assert error["retryable"] is True


async def test_reap_leaves_terminal_runs_untouched(client) -> None:
    await _insert_terminal(client, run_id="run_done", session_status="completed")
    await _insert_terminal(client, run_id="run_partial", session_status="completed_with_errors")

    engine = get_engine()
    async with engine.begin() as conn:
        await _reap_orphaned_runs(conn)

    for rid in ("run_done", "run_partial"):
        session_status, items = await _statuses(client, rid)
        assert session_status in ("completed", "completed_with_errors")
        assert items[0][0] == "succeeded"
        assert items[0][1] is None  # no recovery error written


async def test_reap_is_noop_when_nothing_orphaned(client) -> None:
    engine = get_engine()
    async with engine.begin() as conn:
        await _reap_orphaned_runs(conn)  # must not raise on an empty/clean DB
