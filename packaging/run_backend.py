"""Frozen-build entry point: boot the FastAPI backend as a standalone server.

Used by both the Nuitka and PyInstaller freezes. Importing ``app.main``
triggers full route registration AND the adapter registry (which imports
``vertex`` -> cryptography), so a successful bind proves the heavy native
extensions actually loaded at runtime — not merely got bundled.

Run unfrozen (dev smoke):  python packaging/run_backend.py
Run frozen:                <dist>/backend/miko-backend(.exe)
"""

from __future__ import annotations

import os
import sys

# Dev only: make the sibling backend/ importable when run from source.
# In a frozen build the package tree is compiled in, so this is a harmless no-op.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.normpath(os.path.join(_HERE, "..", "backend"))
if os.path.isdir(os.path.join(_BACKEND, "app")):
    sys.path.insert(0, _BACKEND)

# Electron launches the frozen exe with stdio:'ignore' (piped stdout deadlocks
# the Nuitka bootstrap) and sets MIKO_BACKEND_LOG so we tee stdout/stderr to a
# file for debugging. Manual runs (no env var) keep console output — so
# double-clicking miko-backend.exe still shows the probe + uvicorn logs.
if os.environ.get("MIKO_BACKEND_LOG"):
    _data_dir = os.environ.get("MIKO_DATA_DIR") or os.path.join(os.path.expanduser("~"), ".miko_prompt_studio")
    os.makedirs(_data_dir, exist_ok=True)
    _logf = open(os.path.join(_data_dir, "backend.log"), "a", encoding="utf-8", buffering=1)
    sys.stdout = _logf
    sys.stderr = _logf
# --- startup import probe: the native extensions most likely to break a freeze.
# FATAL on purpose: if a freeze is missing a native dep, boot must fail so the
# smoke gate catches it — not /api/health passing on a half-broken build.
_probe_failures: list[str] = []
for _mod in ("PIL", "cryptography", "aiosqlite", "pydantic_core", "sqlalchemy"):
    try:
        __import__(_mod)
        print(f"[probe] ok: {_mod}", flush=True)
    except Exception as exc:  # noqa: BLE001
        _probe_failures.append(f"{_mod}: {exc}")
        print(f"[probe] FAIL: {_mod}: {exc}", flush=True)
if _probe_failures:
    print(f"[probe] aborting boot: {len(_probe_failures)} native dep(s) missing", flush=True)
    raise SystemExit(1)

# Full app import: routes + lifespan + adapter registry (vertex -> cryptography).
from app.main import app  # noqa: E402

import uvicorn  # noqa: E402


def main() -> None:
    host = os.environ.get("MIKO_BACKEND_HOST", "127.0.0.1")
    port = int(os.environ.get("MIKO_BACKEND_PORT", "21317"))
    # Run the app object directly (not the "app.main:app" string) so the freeze
    # can trace the import statically.
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
