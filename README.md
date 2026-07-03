# Miko Prompt Studio

面向图像标注任务的本地交互式试验台。快速测试不同 API、模型配置、系统提示词、输出格式和图片输入组织方式下的标注效果与成本。

**核心工作方式**：单图 / 少量图即时调试 → 保存配置 → 小批量测试 → 横向比较 → 结果审阅 → 导出结果。

[![Release](https://img.shields.io/github/v/release/chenxluo/miko-prompt-studio)](https://github.com/chenxluo/miko-prompt-studio/releases)

## 下载

Windows 安装包见 [Releases](https://github.com/chenxluo/miko-prompt-studio/releases) 页面，下载 `Miko Prompt Studio Setup X.X.X.exe` 即可。

## 功能

- 单图 / 多图 Lab 运行，支持拖拽上传
- 系统提示词 / 用户模板编辑，支持 `{{vars.x}}` 变量和 `{{image:N}}` 图文混排
- Provider 配置管理（adapter、base_url、API key 加密存储）
- OpenAI 兼容 API 适配 + SSE 流式输出
- Task 保存 / 版本管理 / Fork
- Batch 批量测试、Compare 矩阵对比
- 结果查看器 + 人工审阅（通过 / 拒绝 / 评分 / 标签）
- 跨运行审阅统计（Analytics）
- 样本集 CSV/JSONL 导入
- JSONL / CSV / HTML 结果导出
- 中 / 英双语切换

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Electron 33 |
| 前端 | React 18 + TypeScript + Vite 6 + Tailwind CSS |
| 后端 | Python 3.10+ + FastAPI + SQLAlchemy 2.0 (async) + SQLite |
| 打包 | Electron Builder + Nuitka |

## 开发

```bash
# 前端
npm install
cd frontend && npm run dev

# 后端（使用 uv）
cd backend
uv sync --extra dev
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 21317 --reload

# 完整开发模式
npm run dev
```

## 构建

```bash
npm run dist
```

输出位于 `release/` 目录。

## 文档

详细开发文档见 [`DEVELOPMENT.md`](DEVELOPMENT.md)。

## License

MIT
