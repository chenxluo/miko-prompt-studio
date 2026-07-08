#!/usr/bin/env node
// Sync the version from the root package.json (single source of truth) into
// every other place that carries a version literal.
//
// Run after editing package.json's "version":
//   npm run bump
//
// Why: keeps frontend/package.json, backend/pyproject.toml, and DEVELOPMENT.md
// in lockstep with the root package so the GUI, backend health endpoint, and
// docs never drift. The GUI (Vite define) and backend health (importlib.metadata)
// read their versions at build/runtime, but these files still hold literals
// that tooling (npm, hatch, readers) rely on.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const version = rootPkg.version;

if (!version) {
  console.error('ERROR: no "version" field in root package.json');
  process.exit(1);
}

let changes = 0;

function setJsonVersion(file) {
  const p = resolve(ROOT, file);
  const obj = JSON.parse(readFileSync(p, 'utf-8'));
  if (obj.version !== version) {
    obj.version = version;
    writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
    console.log(`  ${file}: -> ${version}`);
    changes++;
  }
}

function setTomlVersion(file) {
  const p = resolve(ROOT, file);
  const src = readFileSync(p, 'utf-8');
  const next = src.replace(/^(\s*version\s*=\s*)"[^"]*"/m, `$1"${version}"`);
  if (next !== src) {
    writeFileSync(p, next);
    console.log(`  ${file}: -> ${version}`);
    changes++;
  }
}

function setMarkdownHeaderVersion(file) {
  // Only the **版本：X.Y.Z** header line at the top of the doc is synced;
  // historical version refs in the changelog body are left untouched.
  const p = resolve(ROOT, file);
  const src = readFileSync(p, 'utf-8');
  const next = src.replace(/(\*\*版本：)[0-9][^*]*(\*\*)/, `$1${version}$2`);
  if (next !== src) {
    writeFileSync(p, next);
    console.log(`  ${file}: -> ${version}`);
    changes++;
  }
}

console.log(`Bumping to ${version}:`);
setJsonVersion('frontend/package.json');
setTomlVersion('backend/pyproject.toml');
setMarkdownHeaderVersion('DEVELOPMENT.md');

if (changes === 0) {
  console.log('  (already in sync)');
}
