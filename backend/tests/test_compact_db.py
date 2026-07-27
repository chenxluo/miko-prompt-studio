"""End-to-end test of the compact_db maintenance script's --apply path.

Proves, on a synthetic DB with the real schema: backup is taken, leaked temp
sessions are purged, old completed-run snapshots are nulled (recent ones kept),
and VACUUM actually shrinks the file. Never touches the production DB.
"""
import importlib.util
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import text

from app.config import get_settings
from app.database import get_engine

_BASE_TS = "2026-01-01T00:00:00+00:00"
_BIG = "x" * 50_000  # 50 KB snapshot blob


def _load_compact_db():
    """Load scripts/compact_db.py as a module (scripts/ has no __init__)."""
    path = Path(__file__).resolve().parents[1] / "scripts" / "compact_db.py"
    spec = importlib.util.spec_from_file_location("compact_db", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["compact_db"] = module
    spec.loader.exec_module(module)
    return module


async def _seed(client) -> str:
    """Insert leaked temp sessions + old/recent completed runs into the tmp DB."""
    settings = get_settings()
    db_path = str(settings.db_path)
    engine = get_engine()
    now = datetime.now(timezone.utc)
    old_iso = (now - timedelta(days=20)).isoformat()
    recent_iso = (now - timedelta(days=1)).isoformat()

    async with engine.begin() as conn:
        # Two leaked temp lab sessions (matrix executor scratch).
        for rid in ("run_temp_1", "run_temp_2"):
            await conn.execute(
                text(
                    "INSERT INTO run_sessions (run_id, run_type, name, status, started_at, "
                    "source, config_snapshot, summary, notes, created_at, updated_at) "
                    "VALUES (:rid, 'lab', :name, 'running', :ts, '{}', '{}', '{}', '', :ts, :ts)"
                ),
                {"rid": rid, "name": f"Batch item: {rid}", "ts": _BASE_TS},
            )
            await conn.execute(
                text(
                    "INSERT INTO run_items (run_item_id, run_id, sample_id, status, "
                    "internal_request_snapshot, response, usage, cost, review, estimated_cost, "
                    "created_at, updated_at) VALUES (:iid, :rid, :sid, 'running', :big, "
                    "'{}', '{}', '{}', '{}', 0, :ts, :ts)"
                ),
                {"iid": f"{rid}_i", "rid": rid, "sid": f"{rid}_s", "big": _BIG, "ts": _BASE_TS},
            )
        # One OLD completed run (older than retain cutoff) + one RECENT completed run.
        for rid, started in (("run_old", old_iso), ("run_recent", recent_iso)):
            await conn.execute(
                text(
                    "INSERT INTO run_sessions (run_id, run_type, name, status, started_at, "
                    "source, config_snapshot, summary, notes, created_at, updated_at) "
                    "VALUES (:rid, 'batch', :name, 'completed', :st, "
                    "'{}', '{}', '{}', '', :st, :st)"
                ),
                {"rid": rid, "name": rid, "st": started},
            )
            await conn.execute(
                text(
                    "INSERT INTO run_items (run_item_id, run_id, sample_id, status, "
                    "internal_request_snapshot, response, usage, cost, review, estimated_cost, "
                    "created_at, updated_at) VALUES (:iid, :rid, :sid, 'succeeded', :big, "
                    "'{}', '{}', '{}', '{}', 0, :ts, :ts)"
                ),
                {"iid": f"{rid}_i", "rid": rid, "sid": f"{rid}_s", "big": _BIG, "ts": started},
            )
            await conn.execute(
                text(
                    "INSERT INTO attempts (attempt_id, run_item_id, attempt_index, status, "
                    "started_at, completed_at, created_at, provider_id, adapter_id, model_id, "
                    "provider_request_snapshot, usage, error, latency_ms) "
                    "VALUES (:aid, :iid, 0, 'succeeded', :ts, :ts, :ts, "
                    "'', '', '', :big, '{}', null, 1)"
                ),
                {"aid": f"{rid}_a", "iid": f"{rid}_i", "big": _BIG, "ts": started},
            )
    return db_path


async def test_apply_purges_temp_nuls_old_snapshots_and_vacuum_shrinks(client, tmp_path) -> None:
    compact_db = _load_compact_db()
    db_path = await _seed(client)

    def _footprint() -> int:
        total = Path(db_path).stat().st_size
        wal = Path(db_path + "-wal")
        return total + (wal.stat().st_size if wal.exists() else 0)

    footprint_before = _footprint()

    rc = compact_db.main([f"--db={db_path}", "--apply", "--retain-days=7", "--vacuum"])
    assert rc == 0

    # A timestamped backup must exist alongside the DB.
    backups = list(Path(db_path).parent.glob(Path(db_path).name + ".bak.*"))
    assert backups, "expected a backup file"

    conn = sqlite3.connect(db_path)
    try:
        # Leaked temp sessions gone entirely.
        assert conn.execute(
            "SELECT count(*) FROM run_sessions WHERE run_type='lab'"
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT count(*) FROM run_items WHERE run_id LIKE 'run_temp_%'"
        ).fetchone()[0] == 0
        # OLD completed run: snapshot columns nulled, row preserved.
        assert conn.execute(
            "SELECT internal_request_snapshot FROM run_items WHERE run_id='run_old'"
        ).fetchone()[0] is None
        assert conn.execute(
            "SELECT provider_request_snapshot FROM attempts WHERE run_item_id='run_old_i'"
        ).fetchone()[0] is None
        # RECENT completed run: snapshots preserved (within retention window).
        assert conn.execute(
            "SELECT internal_request_snapshot FROM run_items WHERE run_id='run_recent'"
        ).fetchone()[0] == _BIG
        assert conn.execute(
            "SELECT provider_request_snapshot FROM attempts WHERE run_item_id='run_recent_i'"
        ).fetchone()[0] == _BIG
    finally:
        conn.close()

    # WAL flushed to ~0 by the final TRUNCATE checkpoint.
    wal_path = Path(db_path + "-wal")
    assert (not wal_path.exists()) or wal_path.stat().st_size == 0
    # VACUUM after nulling the big blobs must shrink the total footprint.
    footprint_after = _footprint()
    assert footprint_after < footprint_before, (
        f"footprint did not shrink: {footprint_before} -> {footprint_after}"
    )
