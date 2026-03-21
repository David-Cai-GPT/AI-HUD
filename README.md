# AI-HUD

监控、记录 AI 编码工具（Claude Code、Cursor、OpenCode 等）的运行状态，支持对接 Claude、Qwen 等主流模型。

## 功能

- **会话记录**：上下文用量（含按角色 system/user/assistant 的 token 细分）、活跃工具、用户 prompt、生效的 skill、MCP
- **个人仪表盘**：Web 界面查看概览、会话列表、会话详情、成本统计
- **CLI 工具**：命令行采集、查看、会话详情
- **成本追踪**：按模型、来源聚合 token 与费用

## 快速开始

### 前置要求

- Node.js 18+
- pnpm

### 安装

```bash
pnpm install
pnpm build
```

### 使用

```bash
# 采集一次（被动拉取 OpenCode 等 adapter 的会话数据）
pnpm run cli -- collect

# 查看最近会话
pnpm run cli -- status

# 查看会话详情（含 prompt、tools、skills、MCP）
pnpm run cli -- session show <session_id>

# 通过 OpenCode 运行任务并自动记录（需已安装 opencode CLI）
pnpm run cli -- opencode run "实现登录功能"

# 启动 Web 仪表盘 + 后台采集（每 60 秒）
pnpm run cli -- serve
# 默认端口 3849，浏览器访问 http://localhost:3849

# 指定端口
pnpm run cli -- serve --port 8080
# 或
pnpm run cli -- serve -p 8080
```

### 全局安装（可选）

```bash
pnpm add -g .
ai-hud status
ai-hud serve              # 默认 3849 端口
ai-hud serve --port 8080  # 指定端口
```

## 数据存储

默认路径：`~/.ai-hud/data/ai-hud.db`（SQLite）

**OpenCode 采集说明**：通过 `ai-hud opencode run` 执行的任务会实时采集；在其他终端直接运行 `opencode run` 的会话，可通过 `ai-hud collect` 被动拉取并入库。

**Cursor 采集说明**（macOS）：被动扫描 `~/Library/Application Support/Cursor/User/workspaceStorage` 下的 `state.vscdb`，解析 composer 会话并入库。模型与 token 数据不在本地存储。

**Cursor API 用量**（Enterprise 团队）：在 Web 仪表盘「设置」中配置 Cursor API Key（从 cursor.com/settings 获取），点击「刷新用量」从 Cursor Analytics API 拉取团队 model 用量并缓存到本地展示。

**Claude Code 采集说明**：被动扫描 `~/.claude/projects` 下的 session JSONL 文件，解析模型、token、成本、工具调用等并入库。

## 支持的来源

| 来源 | 采集方式 | 状态 |
|------|----------|------|
| OpenCode | 流式（`opencode run --format json`）+ 被动（`opencode session list` + `export`） | ✅ |
| Cursor | 被动扫描本地 workspaceStorage + API 用量（Enterprise） | ✅ |
| Claude Code | 被动扫描 ~/.claude/projects JSONL | ✅ |

## 项目结构

```
packages/
├── core/       # 数据模型、存储、Collector
├── adapters/   # OpenCode、Cursor、Claude Code 等 adapter
├── cli/        # 命令行入口
└── web/        # Web 仪表盘
```

## License

MIT
