# Miko Prompt Studio — 开发文档

> 随开发进度持续更新的配套文档。最后更新：2026-06-24

**版本：0.3.0**

## 1. 项目定位

面向图像标注任务的本地交互式试验台，用于快速测试不同 API、模型配置、系统提示词、输出格式和图片输入组织方式下的标注效果与成本。

核心工作方式：单图 / 少量图即时调试 → 保存配置 → 小批量测试 → 横向比较 → 导出结果。

详见 `plan/设计文档.md`（总体设计）和 `plan/文件格式文档.md`（核心数据结构）。

## 2. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | Electron 33 | 主进程管理窗口 + Python 后端子进程 |
| 前端 | React 18 + TypeScript + Vite 6 | Tailwind CSS 暗色主题，Zustand 状态管理，react-markdown 渲染输出 |
| 后端 | Python 3.10+ + FastAPI + SQLAlchemy 2.0 (async) | SQLite 本地数据库，httpx 调 API（含 SSE 流式） |
| 加密 | cryptography (Fernet) | API key 加密存储 |
| 图片处理 | Pillow | 预处理（resize/crop/format/compress/总像素限制） |

## 3. 项目结构

```
miko_prompt_studio/
├── package.json                # Electron 应用入口 + dev 脚本
├── plan/                       # 设计文档（只读参考）
│   ├── 设计文档.md
│   └── 文件格式文档.md
│
├── backend/                    # Python FastAPI 后端
│   ├── pyproject.toml
│   └── app/
│       ├── config.py           # 配置：数据目录、端口、加密 key
│       ├── database.py         # SQLAlchemy async engine + session
│       ├── main.py             # FastAPI 应用 + 全部 API 路由
│       │
│       ├── schemas/            # Pydantic v2 数据模型
│       │   ├── common.py             # 枚举、TimestampedModel、NormalizedError
│       │   ├── sample_record.py      # SampleRecord, ImageRef, SampleSet
│       │   ├── internal_request.py   # InternalRequest（provider 无关标准请求）
│       │   ├── run_record.py         # RunSession / RunItem / Attempt 三层结构 + StreamEvent
│       │   ├── prompt.py             # Prompt, PromptVersion, PromptSnapshot
│       │   ├── model_config.py       # ModelConfig, ModelParameters, ProviderCapability
│       │   ├── output_contract.py    # OutputContract（5 种输出模式）
│       │   ├── pricing.py            # PricingProfile, CostEstimate
│       │   ├── provider_config.py    # ProviderConfig（绑定 adapter+base_url+key + cached/selected models）
│       │   └── task.py               # Task（保存 Lab 配置模板）
│       │
│       ├── models/             # SQLAlchemy ORM（JSON 存复杂数据，标量字段建索引）
│       │   ├── sample.py             # sample_sets, sample_records
│       │   ├── prompt.py             # prompts, prompt_versions
│       │   ├── model_config.py       # model_configs
│       │   ├── pricing.py            # pricing_profiles
│       │   ├── run.py                # run_sessions, run_items, attempts
│       │   ├── provider_config.py    # provider_configs
│       │   ├── settings.py           # settings（key-value 存储）
│       │   └── task.py               # tasks（Lab 配置模板）
│       │
│       ├── core/
│       │   ├── security.py           # Fernet 加密、API key CRUD、脱敏
│       │   └── errors.py             # 自定义异常体系
│       │
│       ├── adapters/           # Provider Adapter 层
│       │   ├── base.py               # BaseAdapter 抽象基类 + execute / execute_stream 编排
│       │   ├── openai_compat.py      # OpenAI 兼容 adapter + SSE 流式解析
│       │   └── registry.py           # adapter 注册 + 元数据
│       │
│       └── services/           # 核心业务逻辑
│           ├── prompt_renderer.py    # {{vars.x}} / {{#vars.x}} 模板渲染 + 条件块
│           ├── image_preprocess.py   # Pillow 图片预处理 + sha256 + 总像素限制
│           ├── request_builder.py    # 组装 InternalRequest
│           ├── parser_engine.py      # 5 种输出模式解析
│           ├── cost_engine.py        # 成本计算（per-1M tokens）
│           ├── run_executor.py       # 运行编排器（核心流程，含 SSE 流式分支）
│           ├── batch_executor.py     # Batch 运行执行器（Task+SampleSet，多图槽位映射）
│           ├── compare_executor.py   # Compare 矩阵运行执行器（samples × task_versions）
│           ├── contract_validation.py # 输入契约校验（image slots + variables）
│           ├── input_spec_generator.py # 生成 TaskVersion 输入说明文档
│           └── importer.py           # CSV/JSONL 导入 + 智能列映射 + URL/本地路径识别
│
├── frontend/                   # React + TypeScript 前端
│   ├── package.json
│   ├── vite.config.ts          # 含 /api 代理到后端 :21317
│   ├── tailwind.config.js      # 暗色设计系统（surface/ink/accent/cost/danger）
│   └── src/
│       ├── types/index.ts           # 匹配后端 schema 的 TS 类型
│       ├── api/
│       │   ├── client.ts            # fetch 封装 + 全部 API 端点
│       │   └── payloads.ts          # 请求 payload 类型
│       ├── store/
│       │   ├── labStore.ts          # Lab 状态（prompt、图片、provider config、运行、SSE 流式）
│       │   └── settingsStore.ts     # 设置状态（模型配置、定价）
│       ├── i18n/index.ts            # 中/英双语翻译字典 + useI18n hook
│       ├── views/
│       │   ├── LabView.tsx          # Lab 主界面（含三种视图模式切换）
│       │   ├── TasksView.tsx        # Task 列表 + 版本历史 + 输入说明文档弹窗
│       │   ├── SamplesView.tsx      # 样本集列表 + 详情 + 导入对话框
│       │   ├── RunsView.tsx         # 运行容器（Batch / Compare / History 标签页）
│       │   ├── BatchView.tsx        # Batch 测试（Task+SampleSet 选择、估算、运行、结果）
│       │   ├── CompareView.tsx      # Compare 矩阵运行（多 TaskVersion 横向对比）
│       │   ├── RunHistoryView.tsx   # 运行历史（过滤、搜索、详情、导出）
│       │   └── SettingsView.tsx     # 设置页（Provider Config 管理 + 定价）
│       ├── components/
│       │   ├── lab/
│       │   │   ├── ModelBar.tsx     # Provider 选择 + 模型下拉 + 参数 + thinking + stream
│       │   │   ├── ImagePanel.tsx   # 统一槽位网格（槽位即角色）+ Focus Mode + 上传
│       │   │   ├── PromptPanel.tsx  # System/User prompt + 变量编辑器 + 条件块 + 输出模式
│       │   │   ├── ResultPanel.tsx  # 原始/解析/Markdown 结果 + 思维链 + usage + cost
│       │   │   ├── RunHistory.tsx   # 运行历史列表
│       │   │   └── SaveTaskDialog.tsx # 将当前 Lab 配置保存为 Task/TaskVersion
│       │   ├── prompts/
│       │   │   ├── PromptEditor.tsx # Prompt Library 编辑器（变量槽位 + 图像槽位 + few-shot）
│       │   │   ├── ImagePreviewGrid.tsx # 图像预览网格（role 显示）
│       │   │   └── UseAsFewShotDialog.tsx
│       │   ├── samples/
│       │   │   └── ImportDialog.tsx # CSV/JSONL 导入（TaskVersion 校验 + 智能列映射）
│       │   ├── NavButton.tsx
│       │   ├── PlaceholderView.tsx
│       │   └── LocaleSwitch.tsx     # 中/英语言切换
│       ├── App.tsx                  # 侧边栏导航 + 视图切换
│       └── main.tsx
│
└── electron/                   # Electron 壳
    ├── main.ts                 # 主进程：后端管理 + 窗口 + IPC 文件对话框
    ├── preload.ts              # contextBridge 安全暴露
    ├── tsconfig.json
    └── dist-electron/          # 编译产物
```

## 4. 核心数据流

```
用户在 Lab 中操作
  │
  ├── 拖入图片 → POST /api/upload/image → 返回 url
  ├── 写 system/user prompt（支持 {{image:N}} 图文混排）
  ├── 选 ProviderConfig（绑定 adapter + base_url + 加密 key）
  ├── 选/拉取模型 ID
  ├── 调参数（temperature、max_tokens、thinking 等）
  └── 点击 Run
      │
      ▼
POST /api/lab/run
  │
  ├── 如果 parameters.stream === true：以 text/event-stream 返回 SSE 事件
  │     （content / reasoning 增量更新，done 后刷新完整 RunDetail）
  ├── 否则：返回完整 RunSession JSON（保持原有同步路径）
  │
  ├── 构建 SampleRecord
  ├── 构建 PromptVersionData
  ├── 解析 ProviderConfig → adapter_id, base_url, api_key
  │
  ▼
run_executor.execute_lab_run()
  │
  ├── request_builder.build_internal_request()
  │     ├── prompt_renderer.render_prompt()     → 渲染 {{vars.x}}
  │     └── image_preprocess.preprocess_image()  → resize/compress/sha256
  │
  ├── 非流式：adapter.execute()
  │     ├── build_provider_request()  → OpenAI 格式（含 {{image:N}} 解析）
  │     ├── send()                    → httpx POST /v1/chat/completions
  │     ├── parse_response()          → 提取 text + reasoning_text + usage + safety
  │     └── normalize_error()         → 统一错误类型
  │
  ├── 流式：adapter.execute_stream()
  │     ├── send_stream()             → httpx.stream POST /v1/chat/completions
  │     ├── 解析 SSE data: 行          → 累积 reasoning_content + content + usage
  │     └── stream_to_result()        → 组装 AdapterResult
  │
  ├── parser_engine.parse_response()  → 按输出模式解析
  ├── cost_engine.calculate_cost()    → 用 pricing snapshot 计算成本（per-1M tokens）
  │
  └── 持久化 RunSession + RunItem + Attempt → SQLite
      │
      ▼
返回 RunSession JSON（或 SSE 事件流） → 前端显示结果 + cost + history
```

## 5. 后端 API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/providers` | 列出已注册 adapter 元数据 |
| POST | `/api/providers/models` | 从 provider 的 `/v1/models` 拉取模型列表 |
| POST | `/api/lab/run` | 执行单次 Lab 运行；`parameters.stream=true` 时返回 SSE |
| GET | `/api/runs` | 列出运行历史 |
| GET | `/api/runs/{id}` | 获取运行详情（含 run items） |
| GET | `/api/runs/{id}/items/{item_id}` | 获取单个 run item |
| PATCH | `/api/runs/{id}/items/{item_id}/review` | 更新人工 review |
| GET | `/api/samples` | 列出样本 |
| POST | `/api/samples` | 创建样本 |
| GET | `/api/sample-sets` | 列出样本集 |
| GET | `/api/prompts` | 列出提示词模板 |
| GET | `/api/prompts/{id}` | 获取提示词模板详情（含所有版本） |
| GET | `/api/prompts/{id}/versions/{version_id}` | 获取指定版本 |
| POST | `/api/prompts` | 保存提示词（新建或新版本；版本号自动递增） |
| DELETE | `/api/prompts/{id}` | 删除提示词及其所有版本 |
| GET | `/api/prompts/{id}/versions/{version_id}/images/{filename}` | 服务 few-shot 示例中持久化的图片 |
| GET | `/api/result-snapshots` | 列出结果快照 |
| POST | `/api/result-snapshots` | 创建结果快照（保存时复制图片到独立目录） |
| GET | `/api/result-snapshots/{id}` | 获取快照详情（含完整运行配置与持久化图片） |
| PATCH | `/api/result-snapshots/{id}` | 更新快照元数据（名称、标签、评分等） |
| DELETE | `/api/result-snapshots/{id}` | 删除快照 |
| GET | `/api/result-snapshots/{id}/images/{filename}` | 服务快照中持久化的图片 |
| GET | `/api/model-configs` | 列出模型配置 |
| POST | `/api/model-configs` | 保存模型配置 |
| GET | `/api/pricing` | 列出定价 |
| POST | `/api/pricing` | 保存定价 |
| GET | `/api/provider-configs` | 列出 Provider 配置 |
| POST | `/api/provider-configs` | 创建/更新 Provider 配置 |
| DELETE | `/api/provider-configs/{id}` | 删除 Provider 配置 |
| GET | `/api/tasks` | 列出已保存的 Task |
| POST | `/api/tasks` | 创建 Task（含首个版本） |
| GET | `/api/tasks/{id}` | 获取 Task 详情（含所有版本） |
| PUT | `/api/tasks/{id}` | 更新 Task 元数据 |
| DELETE | `/api/tasks/{id}` | 删除 Task 及所有版本 |
| POST | `/api/tasks/{id}/versions` | 创建 Task 新版本 |
| GET | `/api/tasks/{id}/versions/{vid}/input-spec` | 生成 TaskVersion 输入说明文档 |
| GET | `/api/tasks/{id}/versions/{vid}/snapshots` | 列出关联到此版本的快照（含响应数据） |
| POST | `/api/batch-runs` | 创建 Batch 运行（Task + SampleSet） |
| POST | `/api/batch-runs/estimate` | 估算 Batch 成本 |
| GET | `/api/batch-runs/{id}/status` | 查询 Batch 运行状态 |
| POST | `/api/batch-runs/{id}/cancel` | 取消 Batch 运行 |
| POST | `/api/batch-runs/{id}/retry-failed` | 重跑失败项 |
| POST | `/api/compare-runs` | 创建 Compare 矩阵运行 |
| POST | `/api/compare-runs/estimate` | 估算 Compare 成本 |
| GET | `/api/compare-runs/{id}/status` | 查询 Compare 运行状态 |
| POST | `/api/compare-runs/{id}/cancel` | 取消 Compare 运行 |
| POST | `/api/upload/image` | 上传图片，返回 url |
| GET | `/api/uploads/{filename}` | 服务上传的图片文件 |
| GET | `/api/sample-images?path=...` | 代理服务任意路径的图片文件（用于样本集绝对路径） |
| GET | `/api/snapshots/{snapshot_id}/images/{filename}` | 服务快照持久化的图片文件 |
| GET | `/api/runs/{id}/export/jsonl` | 导出运行结果为 JSONL（含输入图片路径、变量、prompt） |
| GET | `/api/runs/{id}/export/csv` | 导出运行结果为 CSV（含输入图片路径、变量、prompt） |
| POST | `/api/import/csv/preview` | 预览 CSV |
| POST | `/api/import/csv` | 导入 CSV 为 Sample Set |

## 6. 已实现功能

### Phase 1（已完成）
- [x] Electron + Python 后端打通
- [x] Lab 单图/多图运行（拖拽上传、角色标签、预览）
- [x] Lab 三种视图模式：编辑 / 提示词+结果 / 图片+结果
- [x] System/User prompt 编辑 + `{{vars.x}}` 模板渲染
- [x] 图文混排提示词（`{{image:N}}` 指定图片位置，可视化 chip 插入）
- [x] Provider Config 管理（绑定 adapter + base_url + 加密 key）
- [x] ProviderConfig 缓存/勾选模型列表（selected_models 过滤 Lab 下拉）
- [x] OpenAI 原生 adapter + OpenAI 兼容 adapter
- [x] 从 API 拉取模型列表（`/v1/models`）
- [x] 模型参数编辑（temperature、max_tokens、top_p、seed、stop）
- [x] temperature / top_p 滑块输入
- [x] 流式输出开关 + SSE 流式运行支持
- [x] Thinking 参数（enable_thinking、thinking_budget、reasoning_effort）
- [x] 思维链显示（reasoning_content 解析与折叠展示）
- [x] 5 种输出模式（free_text / soft_sections / loose_json / strict_json / custom）
- [x] Run Record 三层持久化（Session → Item → Attempt）
- [x] 原始响应（可折叠）+ Markdown 渲染 + 解析结果 + Token 用量 + 成本估算显示
- [x] 运行历史列表
- [x] 可编辑 Pricing Profile（per-1M tokens）+ 运行时快照
- [x] API key Fernet 加密存储 + 脱敏显示（随 ProviderConfig）
- [x] 图片分辨率限制（512/768/1024/1536 正方形边长，按总像素同比例缩放）
- [x] Task 保存 / 加载（Lab 配置模板）
- [x] CSV 导入
- [x] 中/英双语切换
- [x] **Prompt Library**：可复用提示词模板管理（版本自动递增、图像槽位、few-shot 示例、图片预览）
- [x] **Result Snapshot Library**：结果快照（保存运行结果 + 输入图片，可载入 Lab 复现）
- [x] Lab PromptPanel 快速切换已保存提示词
- [x] Prompt / Snapshot 批量管理（搜索、多选、批量删除）
- [x] Sample Sets 页面（浏览、导入管理）
- [x] **Sample Sets Library**：样本集管理（CSV/JSONL 文件导入、浏览、详情、删除）
- [x] **Run History 页面**：运行列表（过滤、搜索、分页）、详情抽屉、JSONL/CSV 导出、删除
- [x] **Batch Test MVP**：选择样本集、估算成本、顺序批量运行、实时进度、取消、失败重跑、结果表格
- [x] **Task 版本管理**：Task 拆分为 header + versions，支持多版本、版本历史、按版本加载到 Lab
- [x] **Batch = Task + SampleSet**：Batch 运行基于 Task（含 PromptVersion 引用）+ 样本集，多图按 role_hint 自动匹配槽位
- [x] **Compare Mode**：样本集 × 多 TaskVersion 矩阵运行、横向对比、标记最优、保存优胜配置
- [x] **Variable Specs**：PromptVersion 声明变量槽位（var_id / label / required / default），支持 `{{vars.x}}`、`{{#vars.x}}...{{/vars.x}}` 条件块
- [x] **导入校验**：CSV/JSONL 导入按 TaskVersion 契约校验 image slots + variables，返回 valid/invalid 报告
- [x] **智能列映射**：CSV 导入自动推荐 `image_<role_hint>` / `var_<var_id>` 列名，支持 URL/本地路径自动识别
- [x] **输入说明文档**：`GET /api/tasks/{id}/versions/{vid}/input-spec` 生成完整输入契约（prompt + slots + variables + CSV/JSONL 示例），前端一键复制
- [x] **ImagePanel 统一槽位网格**：槽位与图像合并为统一网格，槽位即角色，上传自动分配、空槽位可编辑设置、Focus Mode 大图对比
- [x] **变量编辑器合并**：声明与使用合为一体（var_id + 值输入 + 齿轮展开元数据），快捷插入变量 + 语法帮助

### Phase 2（v0.3.0 — Prompt 简化 + 快照示例 + UX 改进）
- [x] **模型参数 UX**：temperature/top_p 开关（关→null，开→上次值）；thinking 三态（默认/思考/不思考 → null/true/false）
- [x] **reasoning_text 持久化**：`ParsedResponse` 新增 `reasoning_text` 字段，思考过程保存到数据库
- [x] **错误状态修复**：StatusBadge 处理 failed/timeout/rate_limited/blocked/cancelled/skipped；catch 块设置 lastRunItem 状态
- [x] **流式截断检测**：`finish_reason` 从 SSE → StreamEvent.done → `_result_from_stream_events` 流转，length/content_filter 设错误状态
- [x] **Prompt 简化重构**：PromptVersion 仅保留文本字段（system_prompt/user_template/format_instruction/notes）；specs（image_slot_specs/variable_specs）移至 TaskVersion；移除 few_shot_examples
- [x] **TasksView 两级抽屉**：Level 1 = 任务概览；Level 2 = 版本详情（Prompt 文本、image slots、variables、模型配置、输出契约、CSV 列/示例）；InputSpecModal 集成至 Level 2
- [x] **Snapshot-Task 链接**：`ResultSnapshotORM.linked_task_version_id` 列；`GET /api/tasks/{id}/versions/{vid}/snapshots` 端点；SnapshotLinkPickerModal；SaveSnapshotDialog 复选框
- [x] **快照示例预览**：左侧 520px 面板展示输入缩略图 + 变量 + 可滚动响应文本 + 元信息；点击卡片切换右侧详情视图
- [x] **条件块下拉菜单**：插入条件块改为下拉选择变量规格，替代文本输入框
- [x] **Task 版本保存修复**：`resolvePromptIds` 始终创建新 PromptVersion，不再复用旧 ID
- [x] **样本集图片代理**：`GET /api/sample-images?path=...` 端点代理任意路径图片；SamplesView 使用代理端点替代无效的 `file:///`
- [x] **样本集图片预览**：缩略图增大至 80px，点击弹出全屏预览
- [x] **批量进度条修复**：使用 `session.summary.total_items` 作为分母，不再随轮询增长
- [x] **批量完成面板导出**：ResultsPanel 新增 JSONL/CSV 导出按钮，无需跳转运行历史
- [x] **导出格式增强**：JSONL/CSV 导出包含输入信息（images 路径/角色、vars、rendered prompt），不含 base64 uri
- [ ] Review 标签系统 UI
- [ ] Python Import Script
- [ ] 批量运行并发控制 + 重试分流（并发过载/网络问题/安全拦截区分）
- [ ] 更多原生 adapter（Google Vertex、阿里百炼）
- [ ] 更丰富的图片预处理策略 UI（resize/crop/quality 可视化配置）
- [ ] 系统 keychain 集成
- [ ] Electron 打包分发

## 7. 开发指南

### 环境准备

```bash
# 后端依赖
cd backend
pip install -e .

# 前端依赖
cd frontend
npm install

# Electron 依赖（项目根目录）
cd ..
npm install
```

### 开发模式

```bash
# 方式一：分别启动（推荐开发时用）
cd backend && python -m uvicorn app.main:app --host 127.0.0.1 --port 21317 --reload
cd frontend && npm run dev    # Vite :5173，自动代理 /api 到后端

# 方式二：一键启动全部（含 Electron）
npm run dev    # 项目根目录，concurrently 启动后端+前端+Electron
```

### 数据目录

默认 `~/.miko_prompt_studio/`，可通过 `MIKO_DATA_DIR` 环境变量修改：
- `miko.db` — SQLite 数据库
- `uploads/` — 上传的图片
- `temp/` — 临时上传文件（CSV/JSONL 导入等）
- `cache/preprocessed/` — 预处理后的图片缓存
- `snapshots/` — 结果快照持久化的图片（按 snapshot_id 分目录）
- `prompts/{prompt_id}/{version_id}/` — few-shot 示例持久化的图片
- `master.key` — Fernet 加密主密钥

### 新增 Provider Adapter

1. 在 `backend/app/adapters/` 新建文件，继承 `BaseAdapter`
2. 实现 `list_models`、`get_capability`、`build_provider_request`、`send`、`parse_response`、`parse_usage`、`normalize_error`
3. 在 `registry.py` 注册 + 添加元数据
4. 在 `registry.py` 的 `_ADAPTER_METADATA` 添加 `requires_base_url`、`default_base_url` 等

### 关键设计约束

- **raw response 永远保存**：解析失败也不能丢原始输出
- **快照不可变**：Run Record 保存 prompt/model/pricing 的运行时快照
- **image role 是软标签**：不硬编码枚举
- **不强制结构化输出**：JSON 是可选能力，不是默认路径
- **ProviderConfig 绑定 key**：API key 随 ProviderConfig 存储，不散落

## 8. 已知问题与注意事项

1. **Python 版本**：当前环境为 Python 3.10，`pyproject.toml` 已调整为 `>=3.10`。如升级到 3.11+ 可恢复 `type X = Y` 语法。

2. **前端 `model.providerId` / `model.providerType` i18n key**：Provider 重构后这两个 key 不再使用，保留在字典中未删除，不影响功能。

3. **旧 API Keys 管理已移除**：独立的按 provider_id 存储的 API Keys 管理区已从 Settings 页面移除，API key 现在统一存储在 ProviderConfig 中。

4. **Electron 打包**：`electron-builder` 配置已写好但未实际测试打包。`extraResources` 将 backend 目录打包进去，需要目标机器有 Python 环境。

5. **数据库迁移**：当前使用 `Base.metadata.create_all` + 启动时 ad-hoc `ALTER TABLE` 迁移，无 Alembic。新增表会自动创建；修改已有表结构通过 `database.py` 中的 `_migrate_*` 函数处理。

6. **图片 mime_type**：上传时如果 `file.content_type` 为空，可能返回 `application/octet-stream`。前端 `resolveImageSrc` 已处理这种情况。

7. **流式输出**：开启 `stream=true` 时，`/api/lab/run` 返回 `text/event-stream`。前端实时渲染 reasoning / content 增量，完成后自动刷新持久化的 RunDetail。

## 9. 技术决策记录

| 决策 | 选择 | 原因 |
|---|---|---|
| 前端状态管理 | Zustand | 轻量，无 boilerplate，适合中等复杂度 |
| HTTP 客户端 | httpx (后端) / fetch (前端) | httpx 支持 async + SSE，fetch 无额外依赖 |
| ORM | SQLAlchemy 2.0 async | 成熟、async 支持、SQLite 兼容 |
| 模板渲染 | 自实现正则 | 设计文档要求简单，不引入 Jinja2 |
| i18n | 自实现 | 轻量，无 i18next 依赖，~120 个 key 够用 |
| API key 存储 | Fernet 对称加密（ProviderConfig 内） | MVP 简化方案，后续可迁移到 keychain |
| 图文混排 | `{{image:N}}` token + contentEditable chip | adapter 层解析，不污染 prompt renderer；用户侧隐藏语法 |
| Provider 配置 | ProviderConfig 实体 | 绑定 adapter+url+key+cached/selected models，避免散装配置 |
| 输出渲染 | react-markdown | 比自实现解析器更稳健，支持标准 Markdown |
| 流式传输 | Server-Sent Events (SSE) | OpenAI 兼容 API 的事实标准，易于用 fetch/httpx 实现 |
| 快照图片持久化 | 复制到 `snapshots/{snapshot_id}/` | 避免原图被清理后快照无法查看；同时保留 run record 指针 |
| Few-shot 图片持久化 | 复制到 `prompts/{prompt_id}/{version_id}/` | 提示词版本不可变，图片随版本独立存储 |
| Prompt 版本管理 | 新建版本，自动递增 `vN` | 保留历史，便于对比与回滚 |
| Task 版本管理 | Task header + TaskVersion | TaskVersion 引用 PromptVersion，不复制内容 |
| 变量语法 | `{{vars.x}}` + `{{#vars.x}}...{{/vars.x}}` | 简单条件块，不引入模板引擎 |
| 图像槽位模型 | 槽位即角色（ImageSlotSpec.role_hint = ImageRef.role） | 消除独立 role 手填，上传自动匹配 |
| 输入契约位置 | TaskVersion 上声明 image_slot_specs + variable_specs | Prompt 简化后 specs 移至 TaskVersion，PromptVersion 仅保留文本 |
| Few-shot 示例 | 移除 TaskVersion.few_shot_examples，改用 Snapshot-Task 链接 | 快照关联到 TaskVersion，哪个版本跑出什么结果一目了然 |
| 快照-Task 关联 | `linked_task_version_id` 1:1 | 一个快照关联一个 TaskVersion，够用且简单 |
| 模型参数持久化 | `exclude_none=True`，前端合并 `DEFAULT_MODEL_PARAMETERS` | null 值不入库，加载时与默认值合并 |
| 样本集图片显示 | `GET /api/sample-images?path=...` 后端代理 | 浏览器禁止 `file://`，代理端点安全读取本地文件 |
| 导出格式 | 含输入信息（images 路径/角色、vars、prompt），不含 base64 | 自包含但不过大；图片通过 path 关联原图 |
| CSV 导入校验 | 导入时按 TaskVersion 契约校验 | 提前发现不匹配，避免运行时失败 |
| Compare 运行 | samples × task_versions 矩阵 | 复用 batch_executor 生命周期，run_type="compare" |
| ImagePanel 设计 | 统一槽位网格（槽位=图像容器） | 槽位声明与图像管理一体化，role 自动分配 |
