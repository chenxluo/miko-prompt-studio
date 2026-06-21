# Miko Prompt Studio — 开发文档

> 随开发进度持续更新的配套文档。最后更新：2026-06-21

## 1. 项目定位

面向图像标注任务的本地交互式试验台，用于快速测试不同 API、模型配置、系统提示词、输出格式和图片输入组织方式下的标注效果与成本。

核心工作方式：单图 / 少量图即时调试 → 保存配置 → 小批量测试 → 横向比较 → 导出结果。

详见 `plan/设计文档.md`（总体设计）和 `plan/文件格式文档.md`（核心数据结构）。

## 2. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | Electron 33 | 主进程管理窗口 + Python 后端子进程 |
| 前端 | React 18 + TypeScript + Vite 6 | Tailwind CSS 暗色主题，Zustand 状态管理 |
| 后端 | Python 3.10+ + FastAPI + SQLAlchemy 2.0 (async) | SQLite 本地数据库，httpx 调 API |
| 加密 | cryptography (Fernet) | API key 加密存储 |
| 图片处理 | Pillow | 预处理（resize/crop/format/compress） |

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
│       │   ├── run_record.py         # RunSession / RunItem / Attempt 三层结构
│       │   ├── prompt.py             # Prompt, PromptVersion, PromptSnapshot
│       │   ├── model_config.py       # ModelConfig, ModelParameters, ProviderCapability
│       │   ├── output_contract.py    # OutputContract（5 种输出模式）
│       │   ├── pricing.py            # PricingProfile, CostEstimate
│       │   └── provider_config.py    # ProviderConfig（绑定 adapter+base_url+key）
│       │
│       ├── models/             # SQLAlchemy ORM（JSON 存复杂数据，标量字段建索引）
│       │   ├── sample.py             # sample_sets, sample_records
│       │   ├── prompt.py             # prompts, prompt_versions
│       │   ├── model_config.py       # model_configs
│       │   ├── pricing.py            # pricing_profiles
│       │   ├── run.py                # run_sessions, run_items, attempts
│       │   ├── provider_config.py    # provider_configs
│       │   └── settings.py           # settings（key-value 存储）
│       │
│       ├── core/
│       │   ├── security.py           # Fernet 加密、API key CRUD、脱敏
│       │   └── errors.py             # 自定义异常体系
│       │
│       ├── adapters/           # Provider Adapter 层
│       │   ├── base.py               # BaseAdapter 抽象基类 + execute 编排
│       │   ├── openai_compat.py      # OpenAI 兼容 adapter + OpenAI 原生 adapter
│       │   └── registry.py           # adapter 注册 + 元数据
│       │
│       └── services/           # 核心业务逻辑
│           ├── prompt_renderer.py    # {{vars.x}} 模板渲染
│           ├── image_preprocess.py   # Pillow 图片预处理 + sha256
│           ├── request_builder.py    # 组装 InternalRequest
│           ├── parser_engine.py      # 5 种输出模式解析
│           ├── cost_engine.py        # 成本计算
│           ├── run_executor.py       # 运行编排器（核心流程）
│           └── importer.py           # CSV 导入
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
│       │   ├── labStore.ts          # Lab 状态（prompt、图片、provider config、运行）
│       │   └── settingsStore.ts     # 设置状态（API keys、模型配置、定价）
│       ├── i18n/index.ts            # 中/英双语翻译字典 + useI18n hook
│       ├── views/
│       │   ├── LabView.tsx          # Lab 主界面
│       │   └── SettingsView.tsx     # 设置页（Provider Config 管理 + API Key 管理）
│       ├── components/
│       │   ├── lab/
│       │   │   ├── ModelBar.tsx     # Provider 选择 + 模型 + 参数 + thinking
│       │   │   ├── ImagePanel.tsx   # 图片拖拽上传 + 缩略图 + 预览
│       │   │   ├── PromptPanel.tsx  # System/User prompt + 输出模式
│       │   │   ├── ResultPanel.tsx  # 原始/解析结果 + usage + cost
│       │   │   └── RunHistory.tsx   # 运行历史列表
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
  ├── adapter.execute()
  │     ├── build_provider_request()  → OpenAI 格式（含 {{image:N}} 解析）
  │     ├── send()                    → httpx POST /v1/chat/completions
  │     ├── parse_response()          → 提取 text + usage + safety
  │     └── normalize_error()         → 统一错误类型
  │
  ├── parser_engine.parse_response()  → 按输出模式解析
  ├── cost_engine.calculate_cost()    → 用 pricing snapshot 计算成本
  │
  └── 持久化 RunSession + RunItem + Attempt → SQLite
      │
      ▼
返回 RunSession JSON → 前端显示结果 + cost + history
```

## 5. 后端 API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/providers` | 列出已注册 adapter 元数据 |
| POST | `/api/providers/models` | 从 provider 的 `/v1/models` 拉取模型列表 |
| POST | `/api/lab/run` | 执行单次 Lab 运行（核心端点） |
| GET | `/api/runs` | 列出运行历史 |
| GET | `/api/runs/{id}` | 获取运行详情（含 run items） |
| GET | `/api/runs/{id}/items/{item_id}` | 获取单个 run item |
| PATCH | `/api/runs/{id}/items/{item_id}/review` | 更新人工 review |
| GET | `/api/samples` | 列出样本 |
| POST | `/api/samples` | 创建样本 |
| GET | `/api/sample-sets` | 列出样本集 |
| GET | `/api/prompts` | 列出提示词 |
| POST | `/api/prompts` | 保存提示词（新建或新版本） |
| GET | `/api/model-configs` | 列出模型配置 |
| POST | `/api/model-configs` | 保存模型配置 |
| GET | `/api/pricing` | 列出定价 |
| POST | `/api/pricing` | 保存定价 |
| GET | `/api/provider-configs` | 列出 Provider 配置 |
| POST | `/api/provider-configs` | 创建/更新 Provider 配置 |
| DELETE | `/api/provider-configs/{id}` | 删除 Provider 配置 |
| GET | `/api/settings/api-keys` | 列出已存 key 的 provider |
| PUT | `/api/settings/api-keys/{provider}` | 存储 API key（加密） |
| DELETE | `/api/settings/api-keys/{provider}` | 删除 API key |
| POST | `/api/upload/image` | 上传图片，返回 url |
| GET | `/api/uploads/{filename}` | 服务上传的图片文件 |
| POST | `/api/import/csv/preview` | 预览 CSV |
| POST | `/api/import/csv` | 导入 CSV 为 Sample Set |

## 6. 已实现功能

### Phase 1（已完成）
- [x] Electron + Python 后端打通
- [x] Lab 单图/多图运行（拖拽上传、角色标签、预览）
- [x] System/User prompt 编辑 + `{{vars.x}}` 模板渲染
- [x] Provider Config 管理（绑定 adapter + base_url + 加密 key）
- [x] OpenAI 原生 adapter + OpenAI 兼容 adapter
- [x] 从 API 拉取模型列表（`/v1/models`）
- [x] 模型参数编辑（temperature、max_tokens、top_p、seed、stop）
- [x] Thinking 参数（enable_thinking、thinking_budget、reasoning_effort）
- [x] 图文混排提示词（`{{image:N}}` 指定图片位置）
- [x] 5 种输出模式（free_text / soft_sections / loose_json / strict_json / custom）
- [x] Run Record 三层持久化（Session → Item → Attempt）
- [x] 原始响应 + 解析结果 + Token 用量 + 成本估算显示
- [x] 运行历史列表
- [x] 可编辑 Pricing Profile + 运行时快照
- [x] API key Fernet 加密存储 + 脱敏显示
- [x] CSV 导入
- [x] 中/英双语切换

### 待实现（按设计文档 Phase 2-5）
- [ ] Prompt Library 页面（版本管理、diff）
- [ ] Sample Sets 页面（浏览、导入管理）
- [ ] Run History 页面（详情查看、过滤、导出）
- [ ] Pricing 页面（CRUD 界面）
- [ ] Batch Test（批量运行、进度、取消、失败重跑）
- [ ] Compare Mode（矩阵运行、横向对比）
- [ ] Review 标签系统 UI
- [ ] 导出（JSONL / CSV / 文件夹）
- [ ] JSONL Manifest 导入
- [ ] Python Import Script
- [ ] 更多原生 adapter（Google Vertex、阿里百炼）
- [ ] 图片预处理策略 UI（resize/crop/quality 可视化配置）
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
- `cache/preprocessed/` — 预处理后的图片缓存
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

3. **旧 API Keys 管理**：Settings 页面保留了独立的 API Keys 管理区（按 provider_id 存储），与新的 ProviderConfig（按 provider_config_id 存储）并存。ProviderConfig 是推荐的方式。旧的 API key 机制保留向后兼容。

4. **Electron 打包**：`electron-builder` 配置已写好但未实际测试打包。`extraResources` 将 backend 目录打包进去，需要目标机器有 Python 环境。

5. **数据库迁移**：当前使用 `Base.metadata.create_all`，无 Alembic 迁移。新增表会自动创建，但修改已有表结构需要手动处理或删库重建。

6. **图片 mime_type**：上传时如果 `file.content_type` 为空，可能返回 `application/octet-stream`。前端 `resolveImageSrc` 已处理这种情况。

## 9. 技术决策记录

| 决策 | 选择 | 原因 |
|---|---|---|
| 前端状态管理 | Zustand | 轻量，无 boilerplate，适合中等复杂度 |
| HTTP 客户端 | httpx (后端) / fetch (前端) | httpx 支持 async，fetch 无额外依赖 |
| ORM | SQLAlchemy 2.0 async | 成熟、async 支持、SQLite 兼容 |
| 模板渲染 | 自实现正则 | 设计文档要求简单，不引入 Jinja2 |
| i18n | 自实现 | 轻量，无 i18next 依赖，~80 个 key 够用 |
| API key 存储 | Fernet 对称加密 | MVP 简化方案，后续可迁移到 keychain |
| 图文混排 | `{{image:N}}` token | adapter 层解析，不污染 prompt renderer |
| Provider 配置 | ProviderConfig 实体 | 绑定 adapter+url+key，避免散装配置 |
