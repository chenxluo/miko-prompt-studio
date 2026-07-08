---
name: mps
description: |
  Drive the Miko Prompt Studio CLI (`mps`) to run, inspect, filter, and chain prompt tasks
  into multi-step workflows (classify → route → collect). Use when the user wants to:
  run a prompt task or batch, query run results, derive a sample set from a run's output,
  route samples to different tasks by classification, compare prompt variants, orchestrate
  a prompt pipeline/workflow, or anything involving "mps", "prompt studio", "跑工作流",
  "分类后路由", "分流", "小批量测试". Covers reference syntax (name@version), the filter DSL,
  and orchestration recipes. NOT for production pipelines — this tool is for debugging only.
---

# mps — Miko Prompt Studio CLI orchestration guide

`mps` is the CLI for **Miko Prompt Studio**, a prompt-debugging desktop tool (Electron + Python/FastAPI + SQLite). It runs in-process against the same DB the GUI uses (`~/.miko_prompt_studio/miko.db`), no server needed. The GUI (PipelineView, RunHistory, Results) visualizes whatever the CLI produces.

**This skill covers orchestration**: how to chain tasks into workflows via the CLI. For full per-command reference, see `plan/CLI手册.md` in the project (note: that manual predates the orchestration features below — trust this skill for `name@version` refs, `run items --select/--filter`, `sset from-run`, and `--pipeline-id`).

## When to use mps

- Debug a single prompt on a sample set → `task run`.
- Chain prompts: classify → route to different tasks → collect results → THIS SKILL's focus.
- Compare prompt variants on the same samples → `compare run` (out of scope here; see CLI manual).
- The user says "小批量测试" / "跑一下看效果" / "分流" / "按分类走不同提示词".

## Invocation

```bash
# Recommended (from project root):
cd backend && uv run mps <command> ...

# Equivalent, no install needed:
cd backend && uv run python -m app.cli <command> ...

# Global flag: --json forces JSON (default when piped); --no-json forces human output.
```

Always `cd backend` first — the package lives there. stdout = data, stderr = errors.

## Reference syntax (IMPORTANT — prefer names over UUIDs)

Every command that takes a task or sample-set accepts these forms. **Use names, not raw UUIDs** — names are semantic, copyable from the GUI (each task/sset row has a copy button that yields the reference string), and avoid transcription errors.

| Form | Meaning |
|---|---|
| `task_<id>` / `ss_<id>` / `tv_<id>` | raw UUID (still works, but avoid for hand-typed) |
| `<name>` | task → resolves to its `current_version`; sset → by name |
| `<name>@latest` | explicit pointer to current version |
| `<name>@v3` | pin to version label `v3` |
| `<name>@tv_<id>` | pin to a specific version UUID |

- Delimiter is `@` (not `:`) — avoids Windows-path/shell ambiguity.
- Task and sample-set names are **globally unique**. After deleting a task you cannot recreate one with the same name (use `xhs-classifier-v2` instead).
- If a reference fails, the CLI prints `error: cannot resolve 'X': ... Did you mean: <closest>?` to stderr and exits **67**. Read the "Did you mean" hint.

## Output & exit codes

- `--json` / `--no-json` global. Default: JSON when piped, human table in a TTY.
- Errors → stderr as `error: <message>`, non-zero exit.
- Exit codes (sysexits-aligned):
  - `67` (EX_NOUSER) — task/sset/run not found (reference resolution failure).
  - `65` (EX_DATAERR) — bad filter expression, run not finished, bad input.
  - `73` (EX_CANTCREAT) — name collision (sample set already exists).
  - `1` — generic error.

## Orchestration primitives

These three are the workflow closure. Everything else (CRUD, import, compare) is in the CLI manual.

### 1. `run items` — extract results efficiently

```bash
mps run items <RUN_ID> [--select field1,field2] [--filter EXPR] [--format json|jsonl|csv]
```

- Without flags: full run items (as before).
- `--select` comma-separated dot paths into each item: `sample_id,status,parsed.category,cost.estimated_cost`. Missing fields → null (does not crash).
- `--filter EXPR`: keep only items where EXPR is truthy (see DSL below). Applied before select.
- `--format jsonl`: one JSON object per line — best for piping / token efficiency.
- `RUN_ID` is always a raw `run_...` id (runs have no names).

### 2. `sset from-run` — derive a sample set from a run's output (THE routing primitive)

```bash
mps sset from-run --run-id <RUN_ID> --name <NEW_NAME>
  [--filter EXPR]
  [--carry-response [VAR_NAME]]   # attach run's response to each new record's vars
  [--drop-original]               # discard original images/vars (chain mode)
  [--task-version REF]            # optional: tag set for a target task version
```

**Default (no optional flags)** = ROUTING mode: carry each selected item's **original** sample (its images + vars) into the new set. This is the common case — filter by the classifier's output, reuse the original images for the downstream task.

Three patterns map cleanly:

| Pattern | When | Command |
|---|---|---|
| **Routing (分流)** | classify → pick subset → same original data to task B | `sset from-run --run-id R --filter 'parsed.category=="food"' --name food-set` |
| **Composition (组合)** | task B annotates same images AND sees task A's output | `sset from-run --run-id R --carry-response --name annotated-set` |
| **Chaining (串联)** | task A's output becomes task B's sole input (less common) | `sset from-run --run-id R --carry-response --drop-original --name chain-set` |
| **Composition (independent)** | task B annotates same images, ignores A | no `from-run` needed — just `task run B --sample-set <original-sset>` |

`--carry-response` attaches the run's response to a var (default name `prev_output`):
- If the task has structured output → `prev_output` = the parsed object.
- Else → `prev_output` = the raw text.

Guards: the source run must be finished (`completed` / `completed_with_errors`). A running run → exit 65 with a clear message. Duplicate `--name` → exit 73.

### 3. `task run` — batch run with pipeline tagging

```bash
mps task run <TASK_REF> --sample-set <SSET_REF>
  [--limit N] [--limit-strategy first|random]
  [--concurrency N] [--retries N]
  [--pipeline-id <ID>] [--pipeline-step <LABEL>]
```

Blocking — returns when the run finishes. `--pipeline-id` / `--pipeline-step` are free-form strings stored on the run; the GUI's **PipelineView** groups runs by `pipeline_id` and sorts each group by creation time, showing the step label. Use these to tag chained runs so a human can inspect the whole pipeline in one view.

**Early `run_id` to stderr**: immediately after the run starts, the CLI prints a started event to **stderr** (e.g. `{"event":"started","run_id":"run_xxx"}` in `--json` mode) and flushes, BEFORE the blocking wait. If your shell/session is killed mid-run, you can still recover the `run_id` from that early stderr line.

**Smoke-test sampling**: `--limit 5` takes the FIRST 5 samples by default. For heterogeneous datasets this gives an unrepresentative slice (e.g. all samples from one platform). Use `--limit-strategy random` to shuffle before limiting, so the smoke test covers the variety:
```bash
mps task run <ref> --sample-set <ref> --limit 5 --limit-strategy random
```

**Batch run example** (concurrency + retries):
```bash
mps task run <ref> --sample-set <ref> --concurrency 4 --retries 3 \
  --pipeline-id pipe_<purpose> --pipeline-step annotate
```

### Long-running runs — use `pueue` (DO NOT rely on shell survival)

`task run` is **blocking**. A 2-minute run will exceed most agent shell timeouts and get killed. The CLI worker is an asyncio task in the CLI's own process — **if the process dies, the run dies** (the worker is NOT a daemon). Do not assume a killed CLI keeps running in the background.

For any run expected to exceed ~30s, wrap with **`pueue`** (a persistent task daemon) so the work survives shell timeouts and you can retrieve results later:

```bash
# Submit (returns immediately, runs under pueue's daemon)
cd backend && pueue add -- uv run mps task run <ref> --sample-set <ref> --concurrency 4
# → "Added task to queue" with a pueue task id; the mps run_id is in the task's
#   stdout once it finishes. Check status:
pueue status
# When done, capture the mps run_id from the output:
pueue cat <pueue_task_id>          # shows stdout, which contains the final run summary
# Or follow live:
pueue follow <pueue_task_id>

# For --json mode, the run_id is also on stderr's early started line:
pueue add -- uv run mps --json task run <ref> --sample-set <ref>
```

`pueue` keeps the Python process alive independently of your shell session. This is the supported way to run long batches — the CLI intentionally has no native background mode (avoiding duplication with pueue). See the `pueue-task-runner` skill for full pueue usage.

## Filter DSL

A restricted expression evaluated against each run item. Powered by `simpleeval` — safe subset: comparisons (`==`, `!=`, `<`, `>`), boolean (`and`/`or`/`not`), `in`, attribute access, subscript. **No function calls, no imports, no assignment.**

The item is exposed as attributes (dot notation works on nested JSON):
- `sample_id`, `run_item_id`, `status` — RunItem status is `succeeded`/`failed`/`pending`/`skipped` (NOT "completed").
- `parsed` — the model's structured output (arbitrary JSON object). May be `None` on failed runs.
- `raw_text` — the model's raw text response.
- `usage`, `cost` — dicts. Cost field is often `cost.estimated_cost`.

Examples:
```text
parsed.category == "food"
status == "succeeded"
status in ("failed", "error")
parsed.category == "food" and parsed.confidence > 0.5
cost.estimated_cost > 0.001
```

**Guarding against None**: if `parsed` is None (failed item), `parsed.category` raises a clear FilterError. Always guard: `status == "succeeded" and parsed.category == "food"`. Put the status check FIRST.

Bad filter → exit 65, stderr shows the failing expression and reason.

## Common workflow recipes

**Before committing to a full run**: always smoke-test first with `--limit 5 --limit-strategy random` to catch prompt/format issues cheaply across the data variety. For the full run, wrap in `pueue add` if it may exceed your shell timeout (see "Long-running runs" above).

### Recipe A — Classify → Route → Annotate (the xhs case)

Goal: a classifier sorts images into categories; each category gets a different annotation prompt. Then optionally collect everything.

```bash
cd backend
PIPE="pipe_$(date +%Y%m%d)_xhs_route"

# 0. Smoke test first (representative 5, not just the first 5)
mps task run xhs-classifier --sample-set raw-images --limit 5 --limit-strategy random
# → eyeball output before committing to the full run

# 1. Classify (full run — wrap in pueue if large; run_id also on stderr)
pueue add -- uv run mps task run xhs-classifier --sample-set raw-images \
  --pipeline-id "$PIPE" --pipeline-step classify
# → once done, read the run_id from pueue cat <id>, e.g. run_abc...

# 2. Inspect the classification distribution before routing
mps run items run_abc --select sample_id,parsed.category --format jsonl

# 3. Route: derive one sample set per category (original images carried over)
mps sset from-run --run-id run_abc --filter 'status=="succeeded" and parsed.category=="food"'  --name xhs-food
mps sset from-run --run-id run_abc --filter 'status=="succeeded" and parsed.category=="fashion"' --name xhs-fashion
mps sset from-run --run-id run_abc --filter 'status=="succeeded" and parsed.category=="travel"' --name xhs-travel
mps sset from-run --run-id run_abc --filter 'status!="succeeded"' --name xhs-classify-failed   # triage failures

# 4. Annotate each branch with its specialized prompt
mps task run xhs-annotator-food   --sample-set xhs-food   --pipeline-id "$PIPE" --pipeline-step annotate-food
mps task run xhs-annotator-fashion --sample-set xhs-fashion --pipeline-id "$PIPE" --pipeline-step annotate-fashion
mps task run xhs-annotator-travel --sample-set xhs-travel --pipeline-id "$PIPE" --pipeline-step annotate-travel
```

All runs tagged with the same `$PIPE` show up grouped in the GUI's PipelineView, ordered by creation time, each labeled by its step. The human reviews the whole pipeline there.

### Recipe B — Composition (annotate same data, downstream sees upstream)

```bash
# Task A annotates; task B annotates the SAME images but also sees A's labels.
mps task run labeler-v1 --sample-set eval-100 --pipeline-id "$PIPE" --pipeline-step label
# → run_xyz
mps sset from-run --run-id run_xyz --carry-response --name eval-100-with-labels
mps task run reviewer-v1 --sample-set eval-100-with-labels --pipeline-id "$PIPE" --pipeline-step review
```

The downstream prompt template references `{{prev_output}}` to consume the upstream labels alongside the original images.

### Recipe C — Retry only failures

```bash
mps sset from-run --run-id run_xyz --filter 'status!="succeeded"' --name retry-batch
mps task run my-task --sample-set retry-batch
```

## Critical boundary: debugging ≠ production

**MPS validates prompt quality on small batches. It does NOT validate pipeline correctness at production scale.** The user has a separate, robust production workflow system. Keep these distinct:

- Routing logic you write here (the `--filter` expressions) is a **debug-time approximation**, often hand-derived from eyeballing the dataset. It is NOT the source of truth — production routing lives in the production system's code/tests.
- Small-batch samples may miss edge cases that production hits. Don't claim "works in MPS ⇒ works in prod".
- Ensure the `model_id` used for debugging matches production, otherwise results aren't comparable.
- If the user asks "does this workflow work in production?", point them back to their production system — MPS cannot answer that.

### Output length & format stability is a prompt concern, not a CLI concern

If outputs vary wildly in length (e.g. 100 tokens vs 500+) or carry unwanted markdown formatting, that is a **prompt-engineering** issue — fix it in the system prompt or output_contract, not in the CLI. Concretely:
- Add explicit length/format constraints to the system prompt ("≤200 字, 不使用 markdown, 直接输出纯文本").
- Set `--max-tokens` (or the task's `max_output_tokens`) as a hard ceiling.
- If a contract (structured output) is defined, the parsed field shape is enforced; free-text length/format is not. Use `run items --select raw_text` to inspect raw lengths across a batch and spot drift.

## Tips

- Discover names first: `mps --json task list` / `mps --json sset list`. Pipe to read names + ids.
- `mps task spec <name>` shows what input a task expects (image slots, var slots, CSV columns) before running.
- `mps run items <RUN_ID> --select ... --format jsonl | head` to peek cheaply before committing to a big `sset from-run`.
- Clean up test sets you create: `mps sset rm <name>`.
- All commands respect the global `--json` flag; when scripting, prefix `mps --json` and parse stdout.

## Quick command map (orchestration subset)

| Action | Command |
|---|---|
| List tasks / sample sets | `mps task list` / `mps sset list` |
| Task input spec | `mps task spec <ref>` |
| Run a task on a sample set | `mps task run <ref> --sample-set <ref> [--pipeline-id ID --pipeline-step L]` |
| Extract run results | `mps run items <RUN_ID> [--select f1,f2] [--filter EXPR] [--format jsonl]` |
| Derive sample set from run | `mps sset from-run --run-id <RUN_ID> --name N [--filter EXPR] [--carry-response] [--drop-original]` |
| Query a run | `mps run get <RUN_ID>` |
| Delete a sample set | `mps sset rm <ref>` |
