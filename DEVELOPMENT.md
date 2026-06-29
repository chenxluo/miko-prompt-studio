# Miko Prompt Studio — 开发文档

> 随开发进度持续更新的配套文档。最后更新：2026-06-28

**版本：0.6.0**

## 1. 项目定位

面向图像标注任务的本地交互式试验台，用于快速测试不同 API、模型配置、系统提示词、输出格式和图片输入组织方式下的标注效果与成本。

核心工作方式：单图 / 少量图即时调试 → 保存配置 → 小批量测试 → 横向比较 → 结果审阅 → 导出结果。

详见 `plan/设计文档.md`（总体设计）和 `plan/文件格式文档.md`（核心数据结构）。

## 2. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | Electron 33 | 主进程管理窗口 + Python 后端子进程 |
| 前端 | React 18 + TypeScript + Vite 6 | Tailwind CSS 暗色主题，Zustand 状态管理，react-markdown 渲染输出 |
| 后端 | Python 3.10+ + FastAPI + SQLAlchemy 2.0 (async) | SQLite 本地数据库，httpx 调 API（含 SSE 流式） |
| 加密 | cryptography (Fernet) | API key 加密存储 |
| 图片处理 | Pillow | 预处理（resize/crop/format/compress/总像素限制） |
| 环境管理 | uv | 后端虚拟环境管理，`.venv` 隔离依赖 |

## 3. 项目结构

```
miko_prompt_studio/
├── package.json                # Electron 应用入口 + dev 脚本
├── plan/                       # 设计文档（只读参考）
│
├── backend/                    # Python FastAPI 后端
│   ├── pyproject.toml
│   ├── .venv/                  # uv 管理的虚拟环境
│   └── app/
│       ├── config.py           # 配置：数据目录、端口、加密 key
│       ├── database.py         # SQLAlchemy async engine + session + 迁移
│       ├── main.py             # FastAPI 应用 + 全部 API 路由
│       │
│       ├── schemas/            # Pydantic v2 数据模型
│       │   ├── common.py             # 枚举、TimestampedModel、NormalizedError
│       │   ├── sample_record.py      # SampleRecord, ImageRef, SampleSet
│       │   ├── internal_request.py   # InternalRequest（provider 无关标准请求）
│       │   ├── run_record.py         # RunSession / RunItem / Attempt 三层结构 + StreamEvent
│       │   ├── prompt.py             # Prompt (snippet), PromptSnapshot
│       │   ├── model_config.py       # ModelConfig, ModelParameters, ProviderCapability
│       │   ├── output_contract.py    # OutputContract（4 种输出模式，纯解析）
│       │   ├── pricing.py            # PricingProfile, CostEstimate
│       │   ├── provider_config.py    # ProviderConfig（绑定 adapter+base_url+key + cached/selected models）
│       │   └── task.py               # Task + TaskVersion（内联 prompt 文本）
│       │
│       ├── models/             # SQLAlchemy ORM（JSON 存复杂数据，标量字段建索引）
│       │   ├── sample.py             # sample_sets, sample_records
│       │   ├── prompt.py             # prompts（扁平 snippet，无版本表）
│       │   ├── model_config.py       # model_configs
│       │   ├── pricing.py            # pricing_profiles
│       │   ├── run.py                # run_sessions, run_items, attempts
│       │   ├── provider_config.py    # provider_configs
│       │   ├── settings.py           # settings（key-value 存储）
│       │   └── task.py               # tasks, task_versions（内联 system_prompt/user_template）
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
│           ├── parser_engine.py      # 4 种输出模式解析（soft_sections 按 section_names 匹配）
│           ├── cost_engine.py        # 成本计算（per-1M tokens）
│           ├── run_executor.py       # 运行编排器（核心流程，含 SSE 流式分支）
│           ├── batch_executor.py     # Batch 运行执行器（Task+SampleSet，多图槽位映射）
│           ├── compare_executor.py   # Compare 矩阵运行执行器（samples × task_versions）
│           ├── contract_validation.py # 输入契约校验（image slots + variables）
│           ├── input_spec_generator.py # 生成 TaskVersion 输入说明文档
│           ├── task_doc_generator.py  # 生成 TaskVersion 可复现说明文档（Markdown 导出）
│           ├── html_export.py        # 运行结果导出为自包含 HTML 可视化（内联图片 + 卡片网格）
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
│       │   ├── TasksView.tsx        # Task 列表 + 版本历史 + fork + 示例预览
│       │   ├── PromptsView.tsx      # Prompt snippet 库（扁平，无版本）
│       │   ├── SamplesView.tsx      # 样本集列表 + 详情 + 导入对话框
│       │   ├── RunsView.tsx         # 运行容器（Batch / Compare / History 标签页）
│       │   ├── BatchView.tsx        # Batch 测试 + 图片缩略图 + 结果查看入口
│       │   ├── CompareView.tsx      # Compare 矩阵运行
│       │   ├── RunHistoryView.tsx   # 运行历史（过滤、搜索、详情、导出）
│       │   ├── ResultsView.tsx      # 结果查看器（网格 + 详情 + 审阅 + 对比模式）
│       │   ├── CostView.tsx         # 成本计算器（基于历史均价）
│       │   └── SettingsView.tsx     # 设置页（Provider Config 管理 + 定价）
│       ├── components/
│       │   ├── lab/
│       │   │   ├── ModelBar.tsx     # Provider 选择 + 模型下拉 + 参数 + thinking + stream
│       │   │   ├── ImagePanel.tsx   # 统一槽位网格 + Focus Mode + 上传
│       │   │   ├── PromptPanel.tsx  # System/User prompt + 变量编辑器 + 条件块 + 输出模式
│       │   │   ├── ResultPanel.tsx  # 结果显示（使用提取的组件）
│       │   │   ├── RunHistory.tsx   # 运行历史列表
│       │   │   └── SaveTaskDialog.tsx # 保存为 Task/TaskVersion（radio: 新版本/fork）
│       │   ├── results/
│       │   │   ├── ParsedOutputView.tsx   # 智能解析输出展示（JSON/markdown/分节）
│       │   │   ├── ReasoningBlock.tsx     # 可折叠思维链
│       │   │   └── CollapsibleSection.tsx # 通用可折叠区块
│       │   ├── prompts/
│       │   │   ├── PromptEditor.tsx # Prompt snippet 编辑器
│       │   │   └── ImagePreviewGrid.tsx # 图像预览网格
│       │   ├── samples/
│       │   │   └── ImportDialog.tsx # CSV/JSONL 导入
│       │   ├── NavButton.tsx
│       │   └── LocaleSwitch.tsx     # 中/英语言切换
│       ├── App.tsx                  # 侧边栏导航 + 视图切换
│       └── main.tsx
│
└── electron/                   # Electron 壳
    ├── main.ts                 # 主进程：后端管理 + 窗口 + IPC 文件对话框
    ├── preload.ts              # contextBridge 安全暴露
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
  ├── 否则：返回完整 RunSession JSON
  │
  ├── 构建 SampleRecord
  ├── 构建 PromptVersionData（system_prompt + user_template）
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
  ├── cost_engine.calculate_cost()    → 用 pricing snapshot 计算成本
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
| PATCH | `/api/runs/{id}/items/{item_id}/review` | 更新人工 review（accepted/rating/notes） |
| GET | `/api/samples` | 列出样本 |
| POST | `/api/samples` | 创建样本 |
| GET | `/api/sample-sets` | 列出样本集 |
| PUT | `/api/sample-sets/{id}` | 重命名样本集 |
| GET | `/api/prompts` | 列出提示词片段（扁平，无版本） |
| GET | `/api/prompts/{id}` | 获取提示词片段详情 |
| POST | `/api/prompts` | 保存提示词片段（新建或覆盖） |
| DELETE | `/api/prompts/{id}` | 删除提示词片段 |
| GET | `/api/result-snapshots` | 列出结果快照 |
| POST | `/api/result-snapshots` | 创建结果快照 |
| GET | `/api/result-snapshots/{id}` | 获取快照详情 |
| PATCH | `/api/result-snapshots/{id}` | 更新快照元数据 |
| DELETE | `/api/result-snapshots/{id}` | 删除快照 |
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
| POST | `/api/tasks/{id}/fork` | 从指定版本 fork 出独立 Task |
| GET | `/api/tasks/{id}/versions/{vid}/input-spec` | 生成 TaskVersion 输入说明文档 |
| GET | `/api/tasks/{id}/versions/{vid}/snapshots` | 列出关联到此版本的快照 |
| GET | `/api/tasks/{id}/versions/{vid}/cost-stats` | 获取 TaskVersion 成本统计（历史均价） |
| GET | `/api/tasks/{id}/versions/{vid}/export/markdown` | 导出 TaskVersion 可复现说明文档（Markdown） |
| POST | `/api/batch-runs` | 创建 Batch 运行（Task + SampleSet） |
| GET | `/api/batch-runs/{id}/status` | 查询 Batch 运行状态 |
| POST | `/api/batch-runs/{id}/cancel` | 取消 Batch 运行 |
| POST | `/api/batch-runs/{id}/retry-failed` | 重跑失败项 |
| POST | `/api/compare-runs` | 创建 Compare 矩阵运行 |
| GET | `/api/compare-runs/{id}/status` | 查询 Compare 运行状态 |
| POST | `/api/compare-runs/{id}/cancel` | 取消 Compare 运行 |
| POST | `/api/upload/image` | 上传图片，返回 url |
| GET | `/api/uploads/{filename}` | 服务上传的图片文件 |
| GET | `/api/sample-images?path=...` | 代理服务任意路径的图片文件 |
| GET | `/api/runs/{id}/export/jsonl` | 导出运行结果为 JSONL |
| GET | `/api/runs/{id}/export/csv` | 导出运行结果为 CSV |
| GET | `/api/runs/{id}/export/html` | 导出运行结果为自包含 HTML 可视化 |
| POST | `/api/import/csv/preview` | 预览 CSV |
| POST | `/api/import/csv` | 导入 CSV 为 Sample Set |

## 6. 已实现功能

### Phase 1（v0.1.0–v0.2.0）
- [x] Electron + Python 后端打通
- [x] Lab 单图/多图运行（拖拽上传、角色标签、预览）
- [x] Lab 三种视图模式：编辑 / 提示词+结果 / 图片+结果
- [x] System/User prompt 编辑 + `{{vars.x}}` 模板渲染
- [x] 图文混排提示词（`{{image:N}}` 指定图片位置）
- [x] Provider Config 管理（绑定 adapter + base_url + 加密 key）
- [x] OpenAI 原生 adapter + OpenAI 兼容 adapter
- [x] 流式输出开关 + SSE 流式运行支持
- [x] Thinking 参数 + 思维链显示
- [x] 5 种输出模式（free_text / soft_sections / loose_json / strict_json / custom）
- [x] Run Record 三层持久化（Session → Item → Attempt）
- [x] 运行历史列表 + JSONL/CSV 导出
- [x] 可编辑 Pricing Profile + 运行时快照
- [x] API key Fernet 加密存储
- [x] Task 保存 / 加载 + 版本管理
- [x] CSV/JSONL 导入 + 智能列映射
- [x] Prompt Library + Result Snapshot Library
- [x] Batch Test + Compare Mode
- [x] 中/英双语切换

### Phase 2（v0.3.0 — Prompt 简化 + 快照示例 + UX 改进）
- [x] **模型参数 UX**：temperature/top_p 开关；thinking 三态
- [x] **reasoning_text 持久化**
- [x] **错误状态修复**：StatusBadge 处理全状态；流式截断检测
- [x] **Prompt 简化重构**：specs 移至 TaskVersion；移除 few_shot_examples
- [x] **TasksView 两级抽屉**：任务概览 + 版本详情
- [x] **Snapshot-Task 链接**：快照关联到 TaskVersion
- [x] **快照示例预览**：左侧面板 + 右侧详情
- [x] **Task Fork**：从版本 fork 出独立 Task
- [x] **样本集图片代理 + 大缩略图**
- [x] **批量进度条修复 + 导出按钮**
- [x] **导出格式增强**：含输入信息，不含 base64

### Phase 3（v0.4.0 — 架构清理 + 结果查看器 + 成本计算器）

#### 架构清理
- [x] **format_instruction 全局清除**：从 PromptVersion、OutputContract、PromptSpec、render_prompt、request_builder、openai_compat 中完全移除；OutputContract 不再注入提示词文本，仅管后置解析
- [x] **Prompt 内联到 TaskVersion**：`system_prompt` + `user_template` 直接存于 TaskVersion，移除 `prompt_id`/`prompt_version_id` 外键依赖；SaveTaskDialog 不再调 savePrompt；数据迁移将旧 format_instruction 追加到 system_prompt
- [x] **Prompt snippet 扁平化**：外部 Prompt 从版本化实体简化为扁平 snippet（`{prompt_id, name, system_prompt, user_template, notes, tags}`），无版本、覆盖式编辑；移除 PromptVersionORM 引用
- [x] **数据库迁移**：recreate prompts 表（去掉 NOT NULL description/current_version_id）+ recreate task_versions 表（prompt_id/prompt_version_id 改 nullable）
- [x] **虚拟环境**：使用 uv 管理 `.venv`，`package.json` dev 脚本改为 `.venv\Scripts\python`

#### 结果查看器（ResultsView）
- [x] **结果网格**：响应式卡片布局（缩略图 + 响应预览 + 审阅 badge）
- [x] **全屏详情视图**：左侧大图 + 右侧 ParsedOutputView + ReasoningBlock + 可折叠元数据
- [x] **键盘导航**：←/→ 翻页，Esc 关闭
- [x] **审阅工具栏**：accepted 三态（通过/拒绝/待定）+ 5 星评分 + notes 自动保存
- [x] **乐观更新**：审阅操作即时反映，失败回滚
- [x] **统计条**：总数/成功/失败/平均延迟
- [x] **筛选**：按状态 + 按 sample_id 搜索
- [x] **BatchView 集成**：完成后"查看结果"跳转
- [x] **对比模式**：多选（≤3）并排展示，独立审阅
- [x] **可复用组件提取**：ParsedOutputView / ReasoningBlock / CollapsibleSection 提取到 `components/results/`

#### 成本计算器（CostView）
- [x] **cost-stats 聚合端点**：`GET /api/tasks/{id}/versions/{vid}/cost-stats` 按 task_version 聚合历史运行（总图数/总成本/均价/运行次数/置信度）
- [x] **成本计算器 UI**：多任务版本卡片，每卡显示历史均价 + 样本量 + 置信度 + 数量输入 + 小计，底部汇总总价
- [x] **"定价"页改名"成本"**：导航页从 Pricing placeholder 改为 Cost calculator
- [x] **移除理论估算**：删除 `POST /api/batch-runs/estimate` + `POST /api/compare-runs/estimate` 端点及前端 UI

#### 解析器修复
- [x] **soft_sections 解析器修复**：按配置的 section_names 匹配标题（支持 `## 标题`、`标题:`、`标题：`、`**标题**` 等格式），无配置时 fallback 到启发式

#### 审阅系统清理
- [x] **删除 BUILTIN_REVIEW_LABELS**：移除未使用的 12 个预设标签；Review schema 移除 labels 字段；审阅只保留 accepted + rating + notes

### Phase 4（v0.5.0 — Task 复现说明文档导出）

面向生产标注：把在 Lab 中调试好的 Task 导出为自包含 Markdown 文档，让外部团队/工程师脱离本工具即可复现标注请求，用于大批量标注。

- [x] **导出 Task 说明文档**：`task_doc_generator.py` 生成自包含 Markdown（任务说明 / 模型配置参考 / System+User prompt 原文 / 输入槽位表 / 输出合约 / 消耗统计 / few-shot 复现示例）；`GET /api/tasks/{id}/versions/{vid}/export/markdown` 端点；TasksView 版本详情"导出说明文档"按钮
- [x] **输出合约渲染**：strict_json 的 JSON Schema 递归展平为字段表（含数组 `[]` 展开）；soft_sections 展示配置的 section_names 节标记
- [x] **消耗统计聚合**：导出文档附平均 input/output/total tokens + 平均成本（复用 cost-stats 的 version 过滤口径，样本 <10 标注仅供参考）
- [x] **few-shot 复现示例**：从关联快照提取纯文本示例（变量值 → 填实 prompt → 模型输出 → 解析结果），不嵌图片
- [x] **敏感信息隔离**：导出文档不含 base_url / api_key，模型/提供商信息仅作参考
- [x] **详情页输出合约补全**：TasksView 的 OutputContractView 在 soft_sections 模式展示 section_names（按 mode 过滤，避免切换模式后残留）
- [x] **修复**：SaveTaskDialog 缺失 i18n key（task.saveTo 等）；SampleRecord 导入缺失致 LabRunPayload 未定义；导出 Content-Disposition 中文文件名 latin-1 编码崩溃（RFC 6266 filename*）；占位符说明勘误（vars / 条件块 / {{image:N}}，移除未设计的 sample/metadata）

### Phase 5（v0.6.0 — 批量并发重试 + 运行中断 + HTML 导出）

#### 批量运行并发 + 重试分流
- [x] **有界并发执行**：`batch_executor.py` 从顺序执行改为 `asyncio.Semaphore` 控制的并发池（`max_concurrency` 上限 16）；批量项预创建后并发扇出，进度/统计从首次轮询即反映全集
- [x] **瞬时错误重试**：限流/超时/网络类错误按指数退避 + 抖动重试（`max_retries` 上限 10）；非瞬时错误直接判失败
- [x] **SQLite 并发支持**：开启 WAL + `busy_timeout`，连接池扩容（pool_size=20, max_overflow=10）；Lab 运行在网络调用前 commit，避免长事务跨慢请求串行化写锁
- [x] **重试继承策略**：`retry-failed` 端点继承原运行的并发/重试配置，重跑行为与原运行一致
- [x] **BatchView 配置 UI**：并发数（1/2/4/8）+ 重试次数（0/1/3）选择器，附限流/超时提示

#### Lab 运行中断
- [x] **AbortSignal 贯通**：`runLab` / `runLabStream` 支持 AbortSignal；流式与非流式运行均可在进行中中断
- [x] **中断按钮**：ModelBar 运行中按钮切换为"中断"，触发 `abortRun` 中止当前请求

#### 运行结果 HTML 导出
- [x] **自包含 HTML 可视化**：`html_export.py` 服务端渲染卡片网格 + 统计条，本地图片内联为 base64，单文件即可分发查看
- [x] **导出端点**：`GET /api/runs/{id}/export/html`；RunHistory 详情抽屉 + BatchView 完成后均可导出

#### 修复与清理
- [x] **thinking 关闭时抑制 effort 参数**：OpenAI 兼容 adapter 在 thinking 关闭/默认时不发送 `thinking_budget` / `reasoning_effort`（修复 Qwen3 把 `reasoning_effort` 当作隐式 thinking 开启、产生非预期思维链并击穿 max_tokens）
- [x] **前端同步清除 effort/budget**：ModelBar 在 thinking 关闭/重置时清除残留的 effort/budget 参数
- [x] **成本聚合口径修正**：cost-stats / task_doc 统计纳入 `COMPLETED_WITH_ERRORS` 运行（其成功项仍带真实成本，item 级过滤已排除失败项）
- [x] **修复 Lab 单请求崩溃**：撤销 v0.6.0 误删的 `LabRunPayload` 字段（`image_resolution_enabled` / `image_resolution_target` / `run_name` 实为 `LabRunRequest` 下游在用，误判为未用字段导致 `lab_run` 端点 `AttributeError`）；补回归测试 `test_lab_run.py`
- [x] **ResultsView 小修**：列表拉满 `limit=1000`；header 提升 z-index，避免下拉被遮挡
- [x] **BatchView 切页恢复运行视图**：mount 时查询运行中的 batch run 并恢复 phase/polling（此前切页致组件卸载、丢失运行追踪，切回后回不到运行中页）

### 待实现
- [ ] Python Import Script
- [ ] 更多原生 adapter（Google Vertex、阿里百炼）
- [ ] 代码分割（前端 bundle >500kB）
- [ ] 系统 keychain 集成
- [ ] Electron 打包分发

## 7. 开发指南

### 环境准备

```bash
# 后端依赖（使用 uv 管理虚拟环境）
cd backend
uv venv
uv pip install -e .
# 开发依赖（pytest 等）
uv pip install -e ".[dev]"

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
cd backend && .venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 21317 --reload
cd frontend && npm run dev    # Vite :5173，自动代理 /api 到后端

# 方式二：一键启动全部（含 Electron）
npm run dev    # 项目根目录，concurrently 启动后端+前端+Electron
```

### 数据目录

默认 `~/.miko_prompt_studio/`，可通过 `MIKO_DATA_DIR` 环境变量修改：
- `miko.db` — SQLite 数据库
- `uploads/` — 上传的图片
- `cache/preprocessed/` — 预处理后的图片缓存
- `snapshots/` — 结果快照持久化的图片
- `master.key` — Fernet 加密主密钥

### 新增 Provider Adapter

1. 在 `backend/app/adapters/` 新建文件，继承 `BaseAdapter`
2. 实现 `list_models`、`get_capability`、`build_provider_request`、`send`、`parse_response`、`parse_usage`、`normalize_error`
3. 在 `registry.py` 注册 + 添加元数据

### 关键设计约束

- **raw response 永远保存**：解析失败也不能丢原始输出
- **快照不可变**：Run Record 保存 prompt/model/pricing 的运行时快照
- **image role 是软标签**：不硬编码枚举
- **不强制结构化输出**：JSON 是可选能力，不是默认路径
- **ProviderConfig 绑定 key**：API key 随 ProviderConfig 存储
- **OutputContract 只管后置解析**：不往提示词中注入内容
- **TaskVersion 自包含**：system_prompt + user_template 内联，不依赖外部 Prompt 实体

## 8. 已知问题与注意事项

1. **Python 环境**：使用 `backend/.venv` 虚拟环境，`package.json` 的 `dev:backend` 脚本指定 `.venv\Scripts\python`，不依赖系统 PATH。

2. **前端 bundle 体积**：当前 >500kB，有 code splitting 警告。待优化。

3. **数据库迁移**：使用 `Base.metadata.create_all` + 启动时 ad-hoc `ALTER TABLE` / recreate-table 迁移，无 Alembic。`database.py` 中的 `_migrate_*` / `_recreate_*` 函数按顺序执行。

4. **prompt_versions 表保留**：Phase 3 后不再使用，但旧 run records 的 config_snapshot 引用它，不删除。

5. **Electron 打包**：`electron-builder` 配置已写好但未实际测试。

## 9. 技术决策记录

| 决策 | 选择 | 原因 |
|---|---|---|
| 前端状态管理 | Zustand | 轻量，无 boilerplate |
| HTTP 客户端 | httpx (后端) / fetch (前端) | httpx 支持 async + SSE |
| ORM | SQLAlchemy 2.0 async | 成熟、async 支持、SQLite 兼容 |
| 模板渲染 | 自实现正则 | 不引入 Jinja2 |
| i18n | 自实现 | 轻量，无 i18next 依赖 |
| API key 存储 | Fernet 对称加密 | MVP 简化方案 |
| 图文混排 | `{{image:N}}` token | adapter 层解析 |
| 流式传输 | Server-Sent Events (SSE) | OpenAI 兼容标准 |
| 虚拟环境 | uv + .venv | 隔离系统 Python，避免依赖冲突 |
| Prompt 文本存储 | 内联到 TaskVersion | Task 自包含，无外部 FK 依赖 |
| 外部 Prompt 模型 | 扁平 snippet（无版本） | 快速保存/复用，覆盖式编辑 |
| OutputContract 职责 | 纯后置解析 | 不注入提示词，格式要求由用户在 prompt 中写 |
| 审阅系统 | accepted(三态) + rating(1-5) + notes | 简洁够用，不用标签分类 |
| 结果查看器 | 专用 ResultsView（网格+详情+对比） | 替代导出+外部可视化的工作流 |
| 成本估算 | 基于历史均价（非理论估算） | 标注场景下真实均价比 token 估算可靠 |
| 均价粒度 | 绑定 TaskVersion（非 Task） | Task 改配置后新建版本，旧版本均价不受影响 |
| soft_sections 解析 | 按配置 section_names 匹配标题 | 精确匹配，不靠启发式猜测 |
| 变量语法 | `{{vars.x}}` + `{{#vars.x}}...{{/vars.x}}` | 简单条件块，不引入模板引擎 |
| 图像槽位模型 | 槽位即角色 | 消除独立 role 手填 |
| 快照-Task 关联 | `linked_task_version_id` 1:1 | 简单够用 |
| 模型参数持久化 | `exclude_none=True` + 前端合并默认值 | null 不入库 |
| Task 复现文档 | 自包含 Markdown 导出（脱离工具可复现） | 面向外部规模化标注；敏感信息隔离（不含 base_url/key） |
| 批量执行模型 | 进程内有界并发池 + 瞬时错误重试 | 单机本地工具，无需 Celery/队列；Semaphore + 退避覆盖限流/超时 |
| SQLite 并发 | WAL + busy_timeout + 扩容连接池 | 默认 rollback journal 在并发写时立即 "database is locked"；WAL 让读写并行 |
| 运行中断 | 前端 AbortSignal 中止 HTTP 请求 | 无服务端任务状态机；Lab 单次运行靠取消 fetch 即够，不引入取消令牌 |
| 结果分发格式 | 自包含 HTML（本地图片内联 base64） | 单文件可邮件/离线分发，比 JSONL/CSV 更直观，比 Markdown 保留图文排版 |