#!/usr/bin/env bash
# Freeze the FastAPI backend with Nuitka (standalone / onefolder).
#
# Produces: packaging/dist/backend/miko-backend(.exe)
#
# onefolder (not onefile): Electron ships the folder via extraResources,
# avoiding per-launch self-extraction (startup delay + AV friction).
#
# Prerequisite: either `uv` on PATH, or Nuitka installed in backend/.venv.
#   cd backend && uv pip install nuitka zstandard ordered-set
#
# Run from repo root:  bash packaging/build_nuitka.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- resolve a Python+Nuitka runner -----------------------------------------
VENV_PY="$ROOT/backend/.venv/Scripts/python.exe"
if command -v uv >/dev/null 2>&1; then
  # Preferred: uv supplies Nuitka ephemerally (no venv mutation, survives sync).
  RUN=(uv run --project "$ROOT/backend" --with nuitka --with zstandard --with ordered-set python)
elif [ -x "$VENV_PY" ] && "$VENV_PY" -c "import nuitka" >/dev/null 2>&1; then
  # Fallback: Nuitka already installed in the backend venv (no pip needed).
  RUN=("$VENV_PY")
else
  echo "ERROR: need either 'uv' on PATH or Nuitka installed in backend/.venv." >&2
  echo "       Install uv:  https://docs.astral.sh/uv/" >&2
  echo "       Then:        cd backend && uv pip install nuitka zstandard ordered-set" >&2
  exit 1
fi

OUT_DIR="packaging/dist/backend"
echo "==> Compiling backend (standalone) -> $OUT_DIR  [runner: ${RUN[*]}]"

# PYTHONPATH=backend lets Nuitka resolve `app` at build time.
PYTHONPATH="$ROOT/backend" "${RUN[@]}" -m nuitka \
  --standalone \
  --output-dir="packaging/dist" \
  --output-filename="miko-backend.exe" \
  --include-package=app \
  --include-package=uvicorn \
  --include-package=pydantic \
  --include-package=pydantic_core \
  --include-package=sqlalchemy \
  --include-package=aiosqlite \
  --include-package=PIL \
  --include-package=cryptography \
  --include-package=httpx \
  --include-package=anyio \
  --include-package-data=PIL \
  --remove-output \
  packaging/run_backend.py

# Nuitka names the folder run_backend.dist; normalize to packaging/dist/backend.
if [ -d "packaging/dist/run_backend.dist" ]; then
  rm -rf "$OUT_DIR"
  mv "packaging/dist/run_backend.dist" "$OUT_DIR"
fi

EXE="$OUT_DIR/miko-backend.exe"
[ ! -f "$EXE" ] && EXE="$OUT_DIR/miko-backend"  # non-Windows fallback

# NOTE: do NOT launch $EXE here — it starts the server and would hang the build.
# Verify the artifact with the packaging smoke gate instead.
ls -lh "$EXE"
echo "==> Done. Artifact: $EXE"
