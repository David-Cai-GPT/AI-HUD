# AI-HUD 设计文档

> 设计日期：2025-03-18

## 概述

AI-HUD 是一个用于监控、记录 AI 编码工具（Claude Code、Cursor、OpenCode 等）运行状态的应用。支持对接主流模型（Claude、Qwen 等），记录每次会话的上下文用量、活跃工具、智能体、任务列表、生效的 skill、MCP 等。

**使用场景**：个人仪表盘、开发调试、成本追踪

**形态**：Web 仪表盘 + CLI 工具

**技术栈**：Node.js / TypeScript，pnpm monorepo

---

## 第一节：整体架构与目录结构

### 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI-HUD                                    │
├─────────────────────────────────────────────────────────────────┤
│  CLI (ai-hud)          │  Web Dashboard (localhost:3xxx)         │
│  - collect [--daemon]  │  - 会话列表 / 详情 / 成本 / 工具统计      │
│  - serve               │  - 实时刷新（轮询）                      │
│  - status / export     │                                         │
├────────────────────────┴────────────────────────────────────────┤
│  Collector (调度器)                                               │
│  - 按优先级轮询各 Adapter                                         │
│  - 合并结果写入 Store                                             │
├─────────────────────────────────────────────────────────────────┤
│  Adapters (插件化)                                                │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │
│  │ OpenCode    │ │ Cursor      │ │ ClaudeCode  │ │ (扩展)      │ │
│  │ 流式+被动   │ │ 被动扫描    │ │ API 拉取    │ │             │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Store (文件存储)                                                 │
│  ~/.ai-hud/data/ai-hud.db (SQLite)                                │
└─────────────────────────────────────────────────────────────────┘
```

### 目录结构

```
ai-hud/
├── packages/
│   ├── core/                 # 核心：模型、存储、调度
│   │   ├── model/            # Session, Event, Metric 等类型
│   │   ├── store/            # FileStore (SQLite)
│   │   └── collector/        # 调度器，调用各 adapter
│   ├── adapters/
│   │   ├── opencode/         # OpenCode adapter
│   │   ├── cursor/           # Cursor adapter
│   │   └── claude-code/      # Claude Code API adapter
│   ├── web/                  # 前端 + Fastify 服务
│   └── cli/                  # 命令行入口
├── package.json              # monorepo (pnpm workspaces)
└── tsconfig.base.json
```

### 运行模式

| 命令 | 行为 |
|------|------|
| `ai-hud serve` | 启动 Web 服务 + 后台采集（轮询或 watch） |
| `ai-hud collect` | 仅执行一次采集 |
| `ai-hud collect --daemon` | 后台持续采集（独立进程） |
| `ai-hud status` | 打印最近会话摘要 |
| `ai-hud export [--format csv\|json]` | 导出数据 |

---

## 第二节：数据模型与存储

### 统一数据模型

```ts
interface Session {
  id: string;
  source: 'opencode' | 'cursor' | 'claude-code' | string;
  startedAt: string;
  endedAt?: string;
  projectPath?: string;
  model?: string;
  contextUsage?: ContextUsage;
  tools?: ToolUsage[];
  agents?: string[];
  skills?: string[];
  mcp?: string[];
  tasks?: TaskItem[];
  cost?: CostInfo;
}

interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreate?: number;
}

interface ToolUsage {
  name: string;
  count: number;
  accepted?: number;
  rejected?: number;
}

interface CostInfo {
  currency: string;
  amount: number;
}

interface TaskItem {
  id?: string;
  content: string;
  status?: 'pending' | 'in_progress' | 'completed';
}
```

### 存储策略

- 默认 SQLite：`~/.ai-hud/data/ai-hud.db`
- 支持按会话追加、按时间范围查询、聚合统计

### 表结构

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  project_path TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read INTEGER,
  cache_create INTEGER,
  cost_amount INTEGER,
  cost_currency TEXT,
  raw_meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_source ON sessions(source);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_model ON sessions(model);
```

### Store 抽象

```ts
interface SessionStore {
  append(session: Session): Promise<void>;
  query(filter: SessionFilter): Promise<Session[]>;
  getById(id: string): Promise<Session | null>;
}

interface SessionFilter {
  source?: string;
  model?: string;
  from?: string;
  to?: string;
  limit?: number;
}
```

---

## 第三节：采集层（Adapters）

### Adapter 接口

```ts
interface SessionAdapter {
  readonly name: string;
  collect(): Promise<Session[]>;
  isAvailable(): Promise<boolean>;
}
```

### OpenCode Adapter

- **主动（流式）**：wrapper 包装 `opencode run --format stream-json`，解析 stdout JSONL
- **被动**：扫描 `~/.opencode/` 或 `./.opencode/` 下的日志/状态文件
- 数据覆盖：model、contextUsage、tools、cost、projectPath

### Cursor Adapter

- **被动**：扫描 `~/.cursor/`、workspaceStorage、项目 `.cursor/`
- 数据来源：cli-config.json、state.vscdb、.cursor/rules、.cursor/settings.json
- 数据覆盖：model、projectPath、skills、mcp、tasks

### Claude Code Adapter

- **API**：调用 Anthropic Admin API `/v1/organizations/usage_report/claude_code`
- 前置：ANTHROPIC_ADMIN_API_KEY，组织账号
- 数据覆盖：model、contextUsage、tools（含 accepted/rejected）、cost

### 扩展点

新增 Adapter：实现 SessionAdapter → 在 Collector 注册，无需改 Store/Web/CLI

### Collector 调度

按 [opencode, cursor, claude-code] 顺序，对每个 adapter 调用 isAvailable()，可用则 collect()，结果 append 到 Store，失败不中断其他。

---

## 第四节：Web 仪表盘

### 页面结构

- 概览：今日/本周会话数、总 token、总成本、按模型/来源分布
- 会话列表：按时间倒序，筛选，点击详情
- 会话详情：上下文用量、工具调用、agents、skills、MCP、任务列表
- 成本分析：按模型、来源、时间聚合
- 工具统计：各工具调用次数、接受率

### 技术选型

- 前端：React + TypeScript，Tailwind / shadcn/ui
- 后端：Fastify，REST API
- 数据：读 Store（SQLite）

### API

```
GET /api/sessions?source=&model=&from=&to=&limit=
GET /api/sessions/:id
GET /api/stats/overview?from=&to=
GET /api/stats/cost?from=&to=&groupBy=model|source|day
GET /api/stats/tools?from=&to=
```

### 刷新

轮询 30–60 秒，无 WebSocket

### 部署

`ai-hud serve` 默认 localhost:3847，仅本地，无认证

---

## 第五节：CLI

### 命令

| 命令 | 说明 |
|------|------|
| `ai-hud serve [--port 3847]` | 启动 Web + 后台采集 |
| `ai-hud collect [--daemon]` | 一次采集 / 持续采集 |
| `ai-hud status [--limit 10]` | 最近会话摘要 |
| `ai-hud export [--format json\|csv] [--from] [--to]` | 导出 |
| `ai-hud config` | 查看/编辑配置 |

### 配置

`~/.ai-hud/config.json`，支持 `apiKey: "${ENV_VAR}"` 引用环境变量

---

## 第六节：错误处理与健壮性

- Adapter 不可用：跳过，warn
- collect() 抛错：捕获，error 日志，返回空数组
- 存储失败：重试，失败则抛出
- 数据去重：Session id 由 source + 原生 id 生成，已存在则 UPDATE 或跳过

---

## 第七节：实施阶段与路线图

| 阶段 | 范围 |
|------|------|
| Phase 1 MVP | core + OpenCode adapter + SQLite + CLI(collect/status) + 最小 Web |
| Phase 2 | Cursor adapter + Web 完整页面 |
| Phase 3 | Claude Code adapter + export + config |
| Phase 4 | 扩展（其他 CLI、Cursor 插件） |

### Phase 1 验收

1. `ai-hud collect` 能解析 OpenCode 并写入 SQLite
2. `ai-hud status` 能输出最近会话
3. `ai-hud serve` 能启动 Web，展示概览和会话列表
4. 单 Adapter 失败不影响其他

---

## 第八节：OpenCode 流式采集与集成

### 实现

- `ai-hud opencode run "任务"`：spawn opencode，解析 stdout JSONL
- step_start → 创建 Session；tool_use → 累加 tools；step_finish → 补全并写入

### 用户集成

- 显式命令：`ai-hud opencode run "任务"`
- Shell alias：`alias opencode='ai-hud opencode run'`
- 被动采集：`ai-hud collect` 扫描日志（若 OpenCode 有落盘）

---

## 附录：需求确认摘要

- 使用场景：1 个人仪表盘、3 开发调试、4 成本追踪
- 形态：Web + CLI
- 采集：混合（被动为主 + OpenCode 流式主动）
- 优先级：OpenCode → Cursor → Claude Code → 其他
- 存储：文件（SQLite）
- 技术栈：Node.js / TypeScript
