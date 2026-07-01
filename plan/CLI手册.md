# Miko Prompt Studio — CLI 手册（`mps`）

> 命令行入口，便于外部 agent / 脚本驱动本工具。进程内直连后端，无需启动 server。
> 配套文档：`DEVELOPMENT.md`。最后更新：2026-06-29

## 1. 概述

`mps` 是 Miko Prompt Studio 的命令行界面。它**直接 import 后端业务逻辑**、用同一个 SQLite 数据库（`~/.miko_prompt_studio/miko.db`）执行操作，**不需要 FastAPI server 在跑**。

架构要点：

- **进程内直连**：复用 route handler 与执行器（`batch_executor` / `compare_executor`），零逻辑重复，与 REST API 行为一致。
- **共享数据目录**：默认 `~/.miko_prompt_studio/`，与桌面 GUI 同库同 key，CLI 看到的就是 GUI 看到的。可用 `MIKO_DATA_DIR` 覆盖。
- **可与 GUI 并存**：SQLite 已开 WAL + busy_timeout，CLI 进程与打开的桌面应用可同时读写。
- **`task run` / `compare run` 是阻塞的**：执行器在本进程 event loop 里跑后台 worker，CLI 必须 await 到完成才退出（否则 worker 会被 loop 关停杀掉）。这对 agent 反而更好——一条命令跑完直接吐结果。

## 2. 安装与调用

CLI 入口在 `backend/app/cli.py`，已注册为 console script `mps`。

```bash
cd backend

# 方式一：uv（推荐）
uv run mps task list

# 方式二：直接模块调用（等价，无需安装 console script）
uv run python -m app.cli task list

# 方式三：已 uv pip install -e . 后，直接用 shim
.venv/Scripts/mps task list        # Windows
.venv/bin/mps task list            # macOS / Linux
```

> 若 `uv sync` 因 `ruff.exe` 被占用而失败（IDE 持有句柄），用 `uv pip install -e . --no-deps` 单独安装本项目即可获得 `mps`，不触发 ruff 重装。

## 3. 全局选项与输出

```
mps [--json | --no-json] <command> ...
```

| 选项 | 说明 |
|---|---|
| `--json` | 强制 JSON 输出 |
| `--no-json` | 强制人类可读输出（表格 / 字段） |
| _(默认)_ | 终端交互 → 人类可读；管道/重定向 → JSON |

**约定**：

- 正常结果走 **stdout**；错误走 **stderr**。
- 错误格式：`error: [404] Task not found`，退出码非 0。
- JSON 模式下 `export` 仍输出原始文件内容（jsonl/csv/html 字节），不走 JSON 包裹。

## 4. 命令参考

### 4.1 task — 任务与版本

```
mps task list [--group GROUP]                                   # 列任务
mps task get  <task_id>                                         # 任务详情（含全部版本）
mps task spec  <task_id> [--version <tv>]                       # 输入说明（见 4.1.1）
mps task new   --name N [--model M ...] [--from-file F]         # 新建 task + v1
mps task edit  <task_id> [版本flags] [--from-file F]            # 编辑 → 派生新版本（见 5）
mps task set-header <task_id> [--name/--description/--tags/--group]   # 改 header，不增版本
mps task fork  <task_id> --name N [--version <tv>]              # fork 成独立 task
mps task run   <task_id> --sample-set S [选项]                  # 跑批量（阻塞，见 4.1.2）
mps task rm    <task_id>                                        # 删 task 及全部版本
mps task rm-version <task_id> <version_id>                      # 删单个版本
```

#### 4.1.1 `task spec` — 任务输入说明

输出 `TaskInputSpec`，是 agent 了解"这个任务要吃什么数据"的速查表：

- `system_prompt` / `user_template`（提示词全文）
- `image_slots`：图片槽（slot_id / role / required / min/max_count）
- `variable_slots`：模板变量（var_id / type / required / default_value）
- `expected_csv_columns`：CSV 导入期望列
- `csv_example_row`：CSV 示例行
- `jsonl_example`：JSONL 示例对象

agent 跑任务前的标准动作：先 `task spec` 看需要哪些图/变量，再据此准备数据导入。

#### 4.1.2 `task run` — 批量运行（阻塞）

```
mps task run <task_id> --sample-set S [--version V] [--limit N] [--concurrency N] [--retries N]
```

- 默认用 task 的 current version；`--version` 指定其它版本。
- 映射到后端 batch-runs：阻塞到全部样本完成，打印 summary（`ok / failed / total` + cost）。
- 结果随后用 `run get/items/export` 查看。

### 4.2 run — 运行记录与导出

```
mps run list   [--type batch|lab|compare] [--status S] [--search Q] [--limit N] [--offset N]
mps run get    <run_id>                    # session summary + items
mps run items  <run_id>                    # 逐条结果（sample/status/tokens/cost）
mps run cancel <run_id>                    # 取消运行中的 batch
mps run export <run_id> --format jsonl|csv|html [--out FILE]
```

### 4.3 sset — 样本集与导入

```
mps sset list                                     # 列样本集
mps sset get  <sample_set_id>                     # 样本集详情
mps sset import-csv  <path> [选项]                # CSV/TSV 导入（见 6.1）
mps sset import-jsonl <path> [选项]               # JSONL 导入（见 6.2）
mps sset rm <sample_set_id>                       # 删样本集及其样本
```

### 4.4 provider / mconfig — 配置发现

```
mps provider list                              # 列 provider 配置（key 脱敏）
mps provider models <provider_config_id> [--api-key K] [--base-url U]   # 拉取在线模型列表
mps mconfig list                               # 列已保存的 model 配置
```

### 4.5 compare — 横向对比（阻塞）

```
mps compare run --sample-set S --variant TASK [--variant TASK ...] [--limit N] [--name N]
```

同一 sample-set 上跑多个 task 的 current version，阻塞到完成。结果用 `run get` 查看对比矩阵。

### 4.6 api — 原始 API 逃生舱

```
mps api <METHOD> <path> [-d JSON | --data-file F]
# METHOD ∈ GET POST PUT PATCH DELETE
# path 形如 /api/tasks、/api/runs/<id>
```

**进程内 ASGI 直连**（`httpx.ASGITransport(app=app)`），不占端口，覆盖**所有** `/api` 端点——包括 CLI 未单独封装的（provider 配置 CRUD、API key、pricing、result snapshot 等）。输出：`HTTP <status>` + body；`--json` 时输出 `{"status": N, "body": {...}}`。

```bash
# 例：保存 provider 配置（CLI 未封装，走逃生舱）
mps api POST /api/provider-configs -d '{"name":"my","adapter_id":"openai_compat","base_url":"http://...","api_key":"sk-..."}'

# 例：删一条 run
mps api DELETE /api/runs/run_xxxx
```

## 5. 编辑模型详解

### 5.1 版本不可变 → 每次编辑派生新版本

后端版本内容不可原地改。`task edit` 的语义是：**基于当前版本复制 → 应用改动 → 写成新版本 → 设为 current**。GUI 行为一致。

- 连续编辑会累加版本（v2 → v3 → …），每个都是独立可复现快照。
- `task set-header` 只改 task 头部（name/description/tags/group），**不**产生新版本。

### 5.2 输入方式：flag + `--from-file` 偏移（混合）

`task new` / `task edit` 共享一组标量 flag，覆盖 80% 小改动；嵌套结构走 `--from-file` JSON 偏移。

**标量 flag**：

| flag | 作用 |
|---|---|
| `--model` / `--provider-config` / `--pricing-profile` | 引用 ID |
| `--temperature` / `--max-tokens` | 模型参数（深合并进现有 model_parameters） |
| `--thinking {on,off,default}` | `enable_thinking` = true/false/null |
| `--thinking-budget N` | thinking_budget |
| `--reasoning-effort {minimal,low,medium,high}` | reasoning_effort |
| `--system-prompt` / `--system-prompt-file` | 系统提示词（二选一） |
| `--user-template` / `--user-template-file` | 用户模板（二选一） |
| `--notes` | 备注 |

**`--from-file`（JSON 偏移）**：用于改嵌套结构。文件是 `TaskVersionData` 的**部分** JSON：

```jsonc
// overlay.json —— 只写要改的字段
{
  "output_contract": { "mode": "soft_sections", "parser": { "type": "sections", "options": { "sections": ["[[FG]]", "[[BG]]"] } } },
  "image_slot_specs": [
    { "slot_id": "slot_1", "role_hint": "slot_1", "required": true, "min_count": 1, "max_count": 1 }
  ]
}
```

合并规则：

- **flag 优先级高于 `--from-file`**（更具体的意图胜出）。
- 嵌套 dict（`model_parameters` / `output_contract` / `image_preprocess_config`）**深合并**。
- 列表（`image_slot_specs` / `variable_specs`）**整体替换**。

`TaskVersionData` 全字段（`--from-file` 可用的 key）：`system_prompt`、`user_template`、`provider_config_id`、`model_id`、`model_parameters`、`output_contract`、`image_preprocess_config`、`image_slot_specs`、`variable_specs`、`pricing_profile_id`、`notes`。

> 典型用法：`mps task get <id> > t.json` → 用 `jq` 删成只含要改的字段 → `mps task edit <id> --from-file t.json`。

## 6. 数据导入详解

### 6.1 `sset import-csv` — CSV/TSV

```
mps sset import-csv <path> [--task-version <tv>] [--name N] [--delimiter ,] [--base-dir D] [--mapping-file F] [--validate-only]
```

- **自动建议列映射**：不给 `--mapping-file` 时，按列名 + `--task-version` 的 image/var 槽自动猜 mapping（复用 `suggest_column_mapping`）。
- `--base-dir`：相对图片路径的前缀。
- `--task-version`：启用契约感知的映射建议 + 导入校验。
- `--mapping-file`：完整 `ColumnMapping` JSON，覆盖自动建议。
- `--validate-only`：只校验不落库。

### 6.2 `sset import-jsonl` — JSONL

```
mps sset import-jsonl <path> [--task-version <tv>] [--name N] [--validate-only]
```

每行一个 `SampleRecord` JSON（含 `sample_id` / `images[{role,path}]` / `vars`）。格式参考 `task spec` 的 `jsonl_example`。

导入返回：`{ sample_set_id, imported_count, validation? }`。

## 7. 典型 agent 工作流

```bash
# 1. 发现：有哪些 task / sample-set / provider
mps task list
mps sset list
mps provider list

# 2. 看任务需要什么输入
mps task spec task_xxxx

# 3. 准备数据（按 spec 的 csv_example_row / jsonl_example 组织文件）
mps sset import-csv data.csv --task-version tv_xxxx --name "实验集A"
# → 拿到 sample_set_id

# 4. 跑
mps task run task_xxxx --sample-set ss_xxxx --limit 50 --concurrency 4
# → 阻塞完成，拿到 run_id

# 5. 取结果
mps run get   run_xxxx          # 概览
mps run items run_xxxx          # 逐条
mps run export run_xxxx --format jsonl --out out.jsonl

# 6.（可选）对比多版本
mps compare run --sample-set ss_xxxx --variant task_a --variant task_b --limit 20
```

**调整现有 task 再跑**：

```bash
mps task edit task_xxxx --temperature 0.5 --thinking off     # → 新版本，自动成 current
# 或改提示词
mps task edit task_xxxx --system-prompt-file new_sp.txt
# 或改嵌套结构
mps task edit task_xxxx --from-file overlay.json
```

## 8. 退出码与错误

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 运行时错误（后端 `HTTPException`、校验失败、找不到资源等） |
| 2 | 参数错误（argparse） |
| 130 | Ctrl+C 中断 |

错误信息一律 stderr：`error: [404] Task not found`。设置 `MIKO_CLI_DEBUG=1` 可看完整 traceback。

## 9. 注意事项

- **`mps` shim 安装**：需项目以 packaged 方式安装（`uv pip install -e .`）。仅 `uv run python -m app.cli` 不需要。
- **与 GUI 并存**：WAL 已开，可同时操作；但高并发写仍受 busy_timeout（5s）约束。
- **未封装端点**：provider 配置 CRUD、API key、pricing、result snapshot、prompt snippet 等暂无专用命令，用 `mps api` 逃生舱（第 4.6 节）。
- **CLI 自动化测试**：handlers 是对已测后端的薄封装；真集成测试需 live provider 或 fixture DB，后续按需补。
