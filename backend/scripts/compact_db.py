"""Maintenance script for the Miko Prompt Studio SQLite database.

Addresses the bloat/lock pattern behind runs like run_9f8979df21124dae:
  * a stalled ~140 MB WAL that makes every commit slow (write-lock contention);
  * leaked "temp" lab sessions left by the matrix executor when a cell crashed;
  * (optional) multi-GB run/attempt request snapshots for old completed runs.

USAGE
-----
Dry-run (default — prints the plan and reclaim estimates, changes nothing):
    python scripts/compact_db.py

Apply the safe subset (WAL checkpoint + purge leaked temp sessions):
    python scripts/compact_db.py --apply

Add retention trimming of heavy snapshots for completed runs older than N days
(nulls run_items.internal_request_snapshot + attempts.provider_request_snapshot;
run results/usage/cost and explicitly-saved result_snapshots are preserved):
    python scripts/compact_db.py --apply --retain-days 14

Rewrite the file to actually shrink it after a big purge (slow, needs disk):
    python scripts/compact_db.py --apply --retain-days 14 --vacuum

PRE-REQUISITES
--------------
STOP the backend first. Checkpoint/VACUUM/purge need exclusive write access;
a running backend holds read snapshots that block the WAL checkpoint and will
make writes contend. The script always takes a timestamped backup before any
write.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import shutil
import sqlite3
import sys
import time

DEFAULT_DB = os.path.expanduser("~/.miko_prompt_studio/miko.db")
_TEMP_NAME_PREFIXES = ("Batch item: ", "Compare item: ")


def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _file_sizes(db_path: str) -> dict[str, int]:
    sizes: dict[str, int] = {}
    for ext, key in (("", "db"), ("-wal", "wal"), ("-shm", "shm")):
        p = db_path + ext
        sizes[key] = os.path.getsize(p) if os.path.exists(p) else 0
    return sizes


def _temp_name_clause(table_alias: str = "") -> str:
    """SQL `name LIKE ... OR ...` clause matching leaked matrix temp sessions."""
    prefix = f"{table_alias}name LIKE " if table_alias else "name LIKE "
    return " OR ".join(f"{prefix}'{p}%'" for p in _TEMP_NAME_PREFIXES)


def _db_metrics(conn: sqlite3.Connection) -> dict:
    cur = conn.cursor()
    page_size = cur.execute("PRAGMA page_size").fetchone()[0]
    page_count = cur.execute("PRAGMA page_count").fetchone()[0]
    freelist = cur.execute("PRAGMA freelist_count").fetchone()[0]
    return {
        "page_size": page_size,
        "page_count": page_count,
        "freelist": freelist,
        "fragment_pct": (freelist / page_count * 100) if page_count else 0.0,
    }


def _leaked_temp_stats(conn: sqlite3.Connection) -> dict:
    cur = conn.cursor()
    clause = _temp_name_clause()
    n_sessions = cur.execute(
        f"SELECT count(*) FROM run_sessions WHERE run_type='lab' AND ({clause})"
    ).fetchone()[0]
    n_items, item_bytes = cur.execute(
        f"""SELECT count(*), coalesce(sum(length(i.internal_request_snapshot)),0)
            FROM run_items i JOIN run_sessions s ON s.run_id = i.run_id
            WHERE s.run_type='lab' AND ({_temp_name_clause('s.')})"""
    ).fetchone()
    return {"sessions": n_sessions, "items": n_items, "item_bytes": item_bytes}


def _retention_stats(conn: sqlite3.Connection, cutoff_iso: str) -> dict:
    cur = conn.cursor()
    n_items, item_bytes = cur.execute(
        """SELECT count(*), coalesce(sum(length(i.internal_request_snapshot)),0)
           FROM run_items i JOIN run_sessions s ON s.run_id = i.run_id
           WHERE s.status IN ('completed','completed_with_errors') AND s.started_at < ?""",
        (cutoff_iso,),
    ).fetchone()
    n_att, att_bytes = cur.execute(
        """SELECT count(*), coalesce(sum(length(a.provider_request_snapshot)),0)
           FROM attempts a JOIN run_items i ON a.run_item_id = i.run_item_id
           JOIN run_sessions s ON s.run_id = i.run_id
           WHERE s.status IN ('completed','completed_with_errors') AND s.started_at < ?""",
        (cutoff_iso,),
    ).fetchone()
    return {
        "items": n_items,
        "attempts": n_att,
        "item_bytes": item_bytes,
        "attempt_bytes": att_bytes,
    }


def _rewrite_assessment(conn: sqlite3.Connection) -> dict:
    """Count existing snapshots still carrying inline image byte payloads."""
    cur = conn.cursor()
    n_items, item_bytes = cur.execute(
        "SELECT count(*), coalesce(sum(length(internal_request_snapshot)),0)"
        " FROM run_items"
        " WHERE internal_request_snapshot LIKE '%data:image%base64%'"
    ).fetchone()
    n_att, att_bytes = cur.execute(
        "SELECT count(*), coalesce(sum(length(provider_request_snapshot)),0)"
        " FROM attempts"
        " WHERE provider_request_snapshot LIKE '%data:image%base64%'"
    ).fetchone()
    return {
        "items": n_items,
        "item_bytes": item_bytes,
        "attempts": n_att,
        "attempt_bytes": att_bytes,
    }


def _rewrite_existing_snapshots(conn: sqlite3.Connection) -> None:
    """Convert existing snapshots to the new small form: rewrite run_items'
    inline image data URIs to serving URLs, and scrub raw image base64 from
    attempts' provider_request_snapshot. Only rows that actually change are
    written back."""
    import json

    from app.services.snapshot_scrub import (
        rewrite_inline_image_uris,
        scrub_image_bytes,
    )

    cur = conn.cursor()
    conn.execute("BEGIN")
    # run_items: rewrite inline image URIs to /api/run-items/{id}/images/{i}.
    rows = cur.execute(
        "SELECT run_item_id, internal_request_snapshot FROM run_items"
        " WHERE internal_request_snapshot LIKE '%data:image%base64%'"
    ).fetchall()
    items_changed = 0
    for run_item_id, snap_json in rows:
        if not snap_json:
            continue
        snapshot = json.loads(snap_json)
        rewritten = rewrite_inline_image_uris(snapshot, run_item_id)
        if rewritten != snapshot:
            cur.execute(
                "UPDATE run_items SET internal_request_snapshot = ?"
                " WHERE run_item_id = ?",
                (json.dumps(rewritten, ensure_ascii=False), run_item_id),
            )
            items_changed += 1
    # attempts: scrub raw image base64 out of provider_request_snapshot.
    arows = cur.execute(
        "SELECT attempt_id, provider_request_snapshot FROM attempts"
        " WHERE provider_request_snapshot LIKE '%data:image%base64%'"
    ).fetchall()
    attempts_changed = 0
    for attempt_id, snap_json in arows:
        if not snap_json:
            continue
        snapshot = json.loads(snap_json)
        scrubbed = scrub_image_bytes(snapshot)
        if scrubbed != snapshot:
            cur.execute(
                "UPDATE attempts SET provider_request_snapshot = ?"
                " WHERE attempt_id = ?",
                (json.dumps(scrubbed, ensure_ascii=False), attempt_id),
            )
            attempts_changed += 1
    conn.execute("COMMIT")
    print(
        f"  rewrote {items_changed:,} run_items, scrubbed {attempts_changed:,} attempts"
    )


def _backup(db_path: str) -> str:
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    backup_path = f"{db_path}.bak.{stamp}"
    for ext in ("", "-wal", "-shm"):
        src = db_path + ext
        if os.path.exists(src):
            shutil.copy2(src, backup_path + ext)
    return backup_path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--db", default=DEFAULT_DB, help=f"DB path (default: {DEFAULT_DB})")
    ap.add_argument(
        "--apply", action="store_true", help="Actually write. Without this, dry-run only."
    )
    ap.add_argument(
        "--retain-days",
        type=int,
        default=None,
        help="Null heavy snapshots for completed runs older than N days.",
    )
    ap.add_argument(
        "--vacuum",
        action="store_true",
        help="VACUUM after other steps (rewrites the file). Only useful after --retain-days.",
    )
    ap.add_argument(
        "--rewrite-image-uris",
        action="store_true",
        help=(
            "Rewrite existing inline image data URIs to serving URLs "
            "(run_items) and scrub them from provider_request_snapshot "
            "(attempts), shrinking existing snapshots to the new small form "
            "while keeping images displayable."
        ),
    )
    ap.add_argument("--no-checkpoint", action="store_true", help="Skip the WAL checkpoint.")
    ap.add_argument(
        "--no-purge-temp",
        action="store_true",
        help="Skip purging leaked temp lab sessions.",
    )
    args = ap.parse_args(argv)

    if not os.path.exists(args.db):
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 2

    print(f"DB: {args.db}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN (no changes)'}")
    before = _file_sizes(args.db)
    print(
        f"Files before: db={_human(before['db'])}  "
        f"wal={_human(before['wal'])}  shm={_human(before['shm'])}"
    )

    # Read-only assessment (works even if the backend is running).
    ro = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True, timeout=5)
    metrics = _db_metrics(ro)
    leaked = _leaked_temp_stats(ro)
    print(
        f"Fragmentation: {metrics['freelist']:,} free pages "
        f"({_human(metrics['freelist'] * metrics['page_size'])}, "
        f"{metrics['fragment_pct']:.2f}%) — VACUUM reclaim without a purge: ~0"
    )
    print(
        f"Leaked temp lab sessions: {leaked['sessions']} sessions / "
        f"{leaked['items']} items, ~{_human(leaked['item_bytes'])}"
    )
    retain = None
    cutoff_iso = None
    if args.retain_days is not None:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.retain_days)
        cutoff_iso = cutoff.isoformat()
        retain = _retention_stats(ro, cutoff_iso)
        print(
            f"Retention trim (completed runs started before {cutoff_iso}, "
            f"{args.retain_days}d):\n"
            f"  {retain['items']:,} run_items → null internal_request_snapshot "
            f"(~{_human(retain['item_bytes'])})\n"
            f"  {retain['attempts']:,} attempts → null provider_request_snapshot "
            f"(~{_human(retain['attempt_bytes'])})"
        )
    rewrite_stats = None
    if args.rewrite_image_uris:
        rewrite_stats = _rewrite_assessment(ro)
        print(
            "Rewrite existing image URIs:\n"
            f"  {rewrite_stats['items']:,} run_items with inline image data "
            f"(~{_human(rewrite_stats['item_bytes'])})\n"
            f"  {rewrite_stats['attempts']:,} attempts with raw image base64 "
            f"(~{_human(rewrite_stats['attempt_bytes'])})"
        )
    ro.close()

    if not args.apply:
        steps = []
        if not args.no_checkpoint:
            steps.append(
                "1. backup + PRAGMA wal_checkpoint(TRUNCATE)  [reclaim WAL into main file]"
            )
        if not args.no_purge_temp:
            steps.append(
                f"2. delete {leaked['sessions']} leaked temp lab sessions + their items  "
                f"[~{_human(leaked['item_bytes'])}]"
            )
        if retain is not None:
            steps.append(
                f"3. null heavy snapshots for {retain['items']:,} old items + "
                f"{retain['attempts']:,} old attempts"
            )
        if args.vacuum:
            steps.append("4. VACUUM (rewrite file — only after step 3 does it shrink meaningfully)")
        if rewrite_stats is not None:
            steps.append(
                f"5. rewrite {rewrite_stats['items']:,} run_item image URIs to serving URLs"
                f" + scrub {rewrite_stats['attempts']:,} attempts  "
                f"[~{_human(rewrite_stats['item_bytes'] + rewrite_stats['attempt_bytes'])}]"
            )
        print("\nDry-run only. Re-run with --apply to execute:")
        print("  " + "\n  ".join(steps) if steps else "  (nothing selected)")
        print("\nReminder: STOP the backend before --apply.")
        return 0

    # ---- APPLY ----
    backup_path = _backup(args.db)
    print(f"\nBackup written to: {backup_path}")

    conn = sqlite3.connect(args.db, timeout=2.0, isolation_level=None)  # autocommit
    conn.execute("PRAGMA busy_timeout=2000")
    try:
        if not args.no_checkpoint:
            t0 = time.time()
            row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            print(
                f"wal_checkpoint(TRUNCATE) -> busy={row[0]} frames={row[1]} "
                f"checkpointed={row[2]} ({time.time()-t0:.1f}s)"
            )
        if not args.no_purge_temp and leaked["sessions"]:
            clause = _temp_name_clause()
            t0 = time.time()
            conn.execute("BEGIN")
            conn.execute(
                "DELETE FROM attempts WHERE run_item_id IN ("
                " SELECT i.run_item_id FROM run_items i JOIN run_sessions s ON s.run_id=i.run_id"
                f" WHERE s.run_type='lab' AND ({_temp_name_clause('s.')}))"
            )
            conn.execute(
                "DELETE FROM run_items WHERE run_id IN ("
                f" SELECT run_id FROM run_sessions WHERE run_type='lab' AND ({clause}))"
            )
            conn.execute(
                f"DELETE FROM run_sessions WHERE run_type='lab' AND ({clause})"
            )
            conn.execute("COMMIT")
            print(
                f"Purged {leaked['sessions']} leaked temp sessions + items "
                f"({time.time()-t0:.1f}s)"
            )
        if retain is not None:
            t0 = time.time()
            conn.execute("BEGIN")
            conn.execute(
                """UPDATE run_items SET internal_request_snapshot = NULL
                   WHERE run_id IN (SELECT run_id FROM run_sessions
                                    WHERE status IN ('completed','completed_with_errors')
                                      AND started_at < ?)""",
                (cutoff_iso,),
            )
            conn.execute(
                """UPDATE attempts SET provider_request_snapshot = NULL
                   WHERE run_item_id IN (
                     SELECT i.run_item_id FROM run_items i JOIN run_sessions s ON s.run_id=i.run_id
                     WHERE s.status IN ('completed','completed_with_errors')
                       AND s.started_at < ?)""",
                (cutoff_iso,),
            )
            conn.execute("COMMIT")
            print(
                f"Retention trim applied for runs older than {args.retain_days}d "
                f"({time.time()-t0:.1f}s)"
            )
        if rewrite_stats is not None:
            t0 = time.time()
            _rewrite_existing_snapshots(conn)
            print(f"Rewrote existing image URIs ({time.time()-t0:.1f}s)")
        if args.vacuum:
            t0 = time.time()
            print("VACUUM (rewriting file, this may take a while)…")
            conn.execute("VACUUM")
            print(f"VACUUM done ({time.time()-t0:.1f}s)")
        if not args.no_checkpoint:
            # Final checkpoint: the DML + VACUUM above generated fresh WAL frames.
            # Flush them so we leave the DB clean and fully checkpointed.
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.OperationalError as exc:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        print(
            f"\nFAILED: {exc!r}\n"
            "Most likely the backend is still running and holds the DB. "
            "Stop it (quit the Electron app fully) and re-run.",
            file=sys.stderr,
        )
        return 1
    finally:
        conn.close()

    after = _file_sizes(args.db)
    print(
        f"\nFiles after:  db={_human(after['db'])}  wal={_human(after['wal'])}  "
        f"shm={_human(after['shm'])}\n"
        f"Main file delta: {_human(after['db'] - before['db'])} "
        f"(negative = shrank); WAL delta: {_human(after['wal'] - before['wal'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
