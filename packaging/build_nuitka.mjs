#!/usr/bin/env node
// Freeze the FastAPI backend with Nuitka (standalone / onefolder).
//
// Produces: packaging/dist/backend/miko-backend(.exe)
//
// WHY NODE (not bash/pwsh): npm runs scripts via cmd.exe on Windows, where
// `bash` is unavailable. Node is always present in this Electron project, so
// `node packaging/build_nuitka.mjs` runs from any npm shell (cmd/powershell/
// bash) AND is cross-platform — the same command drives Windows/macOS/Linux
// builds (Nuitka can't cross-compile, so per-OS CI reuses this verbatim).
//
// Prerequisite: either `uv` on PATH, or Nuitka installed in backend/.venv.
//   cd backend && uv pip install nuitka zstandard ordered-set
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'backend');
const DIST = join(ROOT, 'packaging', 'dist');
const OUT_DIR = join(DIST, 'backend');
const EXE_NAME = process.platform === 'win32' ? 'miko-backend.exe' : 'miko-backend';
const VENV_PY = process.platform === 'win32'
  ? join(BACKEND, '.venv', 'Scripts', 'python.exe')
  : join(BACKEND, '.venv', 'bin', 'python');

function onPath(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

// --- resolve runner: prefer uv (ephemeral Nuitka); else venv python ----------
let runner;
if (onPath('uv')) {
  runner = ['uv', 'run', '--project', BACKEND,
            '--with', 'nuitka', '--with', 'zstandard', '--with', 'ordered-set',
            'python'];
} else if (existsSync(VENV_PY) && spawnSync(VENV_PY, ['-c', 'import nuitka'], { stdio: 'ignore' }).status === 0) {
  runner = [VENV_PY]; // Nuitka already installed in the venv (no pip needed)
}
if (!runner) {
  console.error("ERROR: need either 'uv' on PATH or Nuitka installed in backend/.venv.");
  console.error('       Install uv:  https://docs.astral.sh/uv/');
  console.error('       Then:        cd backend && uv pip install nuitka zstandard ordered-set');
  process.exit(1);
}

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });

const args = runner.slice(1).concat([
  '-m', 'nuitka',
  '--standalone',
  '--output-dir=' + DIST,
  '--output-filename=' + EXE_NAME,
  '--include-package=app',
  '--include-package=uvicorn',
  '--include-package=pydantic',
  '--include-package=pydantic_core',
  '--include-package=sqlalchemy',
  '--include-package=aiosqlite',
  '--include-package=PIL',
  '--include-package=cryptography',
  '--include-package=httpx',
  '--include-package=anyio',
  '--include-package-data=PIL',
  '--remove-output',
  join(ROOT, 'packaging', 'run_backend.py'),
]);

console.log(`==> Compiling backend (standalone) -> ${OUT_DIR}`);
console.log(`    runner: ${runner.join(' ')}`);

const env = { ...process.env, PYTHONPATH: BACKEND };
const r = spawnSync(runner[0], args, { env, stdio: 'inherit' });
if (r.status !== 0) {
  console.error(`==> Nuitka failed (exit ${r.status ?? 1})`);
  process.exit(r.status ?? 1);
}

// Nuitka names the folder run_backend.dist; normalize to packaging/dist/backend.
const built = join(DIST, 'run_backend.dist');
if (existsSync(built)) renameSync(built, OUT_DIR);

const exe = join(OUT_DIR, EXE_NAME);
if (!existsSync(exe)) {
  console.error(`==> Expected artifact not found: ${exe}`);
  process.exit(1);
}
console.log(`==> Done. Artifact: ${exe} (${(statSync(exe).size / 1048576).toFixed(0)}MB)`);
// NOTE: do not launch $EXE here — it starts the server and would hang the build.
