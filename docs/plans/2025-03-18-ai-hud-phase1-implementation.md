# AI-HUD Phase 1 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 MVP：能采集 OpenCode 会话，在 Web 仪表盘和 CLI 中查看。

**Architecture:** pnpm monorepo，core 包定义数据模型与存储，opencode adapter 实现采集，cli 与 web 共享 core。存储使用 SQLite。

**Tech Stack:** Node.js 18+, TypeScript, pnpm workspaces, better-sqlite3 或 sql.js, Fastify, React, commander

---

## Task 1: 初始化 Monorepo

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/core/package.json`
- Create: `packages/cli/package.json`
- Create: `packages/web/package.json`
- Create: `packages/adapters/package.json`

**Step 1: 根 package.json**

```json
{
  "name": "ai-hud",
  "private": true,
  "scripts": {
    "build": "pnpm -r run build",
    "dev": "pnpm -r run dev"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

**Step 2: pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

**Step 3: tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist"
  },
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: 各 packages 的 package.json**

- `packages/core`: name: `@ai-hud/core`，dependencies: `better-sqlite3`
- `packages/cli`: name: `ai-hud`，dependencies: `@ai-hud/core`，bin: `ai-hud`
- `packages/web`: name: `@ai-hud/web`，dependencies: `@ai-hud/core`，`fastify`，`@fastify/static`
- `packages/adapters`: name: `@ai-hud/adapters`，dependencies: `@ai-hud/core`

**Step 5: 验证**

```bash
pnpm install
```

Expected: 无报错

**Step 6: Commit**

```bash
git add .
git commit -m "chore: init pnpm monorepo"
```

---

## Task 2: Core - 数据模型

**Files:**
- Create: `packages/core/src/model/session.ts`
- Create: `packages/core/src/model/index.ts`
- Create: `packages/core/tsconfig.json`

**Step 1: session.ts**

```ts
export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreate?: number;
}

export interface ToolUsage {
  name: string;
  count: number;
  accepted?: number;
  rejected?: number;
}

export interface CostInfo {
  currency: string;
  amount: number;
}

export interface TaskItem {
  id?: string;
  content: string;
  status?: 'pending' | 'in_progress' | 'completed';
}

export interface Session {
  id: string;
  source: string;
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
```

**Step 2: index.ts 导出**

**Step 3: 验证**

```bash
cd packages/core && pnpm exec tsc --noEmit
```

**Step 4: Commit**

```bash
git add packages/core
git commit -m "feat(core): add Session data model"
```

---

## Task 3: Core - Store 接口与 SQLite 实现

**Files:**
- Create: `packages/core/src/store/types.ts`
- Create: `packages/core/src/store/sqlite-store.ts`
- Create: `packages/core/src/store/index.ts`
- Create: `packages/core/src/index.ts`

**Step 1: types.ts**

```ts
import type { Session } from '../model/index.js';

export interface SessionFilter {
  source?: string;
  model?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface SessionStore {
  append(session: Session): Promise<void>;
  query(filter: SessionFilter): Promise<Session[]>;
  getById(id: string): Promise<Session | null>;
}
```

**Step 2: sqlite-store.ts**

实现 SqliteStore，路径默认 `~/.ai-hud/data/ai-hud.db`，启动时创建目录和表。

**Step 3: 验证**

手动调用 append + query，确认数据写入和读取正确。

**Step 4: Commit**

```bash
git add packages/core
git commit -m "feat(core): add SqliteStore implementation"
```

---

## Task 4: Adapter 接口与 OpenCode Adapter 骨架

**Files:**
- Create: `packages/adapters/src/types.ts`
- Create: `packages/adapters/src/opencode/index.ts`
- Create: `packages/adapters/tsconfig.json`

**Step 1: types.ts**

```ts
import type { Session } from '@ai-hud/core';

export interface SessionAdapter {
  readonly name: string;
  collect(): Promise<Session[]>;
  isAvailable(): Promise<boolean>;
}
```

**Step 2: opencode/index.ts**

实现 OpenCodeAdapter，isAvailable 检查 `opencode` 命令是否存在，collect 暂时返回空数组。

**Step 3: 验证**

```bash
cd packages/adapters && pnpm exec tsc --noEmit
```

**Step 4: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): add SessionAdapter interface and OpenCode skeleton"
```

---

## Task 5: OpenCode Adapter - 流式采集实现

**Files:**
- Modify: `packages/adapters/src/opencode/index.ts`

**Step 1: 实现 collect**

- 若无可解析的被动数据源，先实现 `opencode run --format stream-json` 的 wrapper 逻辑
- 或：实现被动扫描 `~/.opencode/` 下日志（需确认 OpenCode 是否输出）
- 优先：实现 `run` 子命令 `ai-hud opencode run "任务"`，spawn opencode，解析 stdout JSONL，聚合为 Session，写入 Store

**Step 2: 事件映射**

step_start → 创建 Session；tool_use → tools；step_finish → 补全 contextUsage、cost、endedAt

**Step 3: 验证**

在已安装 opencode 的环境执行 `ai-hud opencode run "echo hello"`，检查 Store 中是否有新 Session。

**Step 4: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): implement OpenCode stream collection"
```

---

## Task 6: Collector 调度器

**Files:**
- Create: `packages/core/src/collector/index.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 实现 Collector**

- 接收 Adapter 数组，按顺序调用 isAvailable，可用则 collect
- 合并所有 Session，逐个 append 到 Store
- 单 Adapter 失败捕获，记录日志，继续下一个

**Step 2: 验证**

注入 OpenCodeAdapter，调用 run，确认 Store 有数据。

**Step 3: Commit**

```bash
git add packages/core
git commit -m "feat(core): add Collector with adapter orchestration"
```

---

## Task 7: CLI - collect 与 status

**Files:**
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/tsconfig.json`

**Step 1: 使用 commander**

- `ai-hud collect`：实例化 Collector，执行一次采集
- `ai-hud status [--limit 10]`：从 Store query，打印表格到终端

**Step 2: 验证**

```bash
pnpm exec tsx packages/cli/src/index.ts collect
pnpm exec tsx packages/cli/src/index.ts status
```

**Step 3: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add collect and status commands"
```

---

## Task 8: Web - API 与最小前端

**Files:**
- Create: `packages/web/src/server.ts`
- Create: `packages/web/src/routes/sessions.ts`
- Create: `packages/web/public/index.html`（或 React 入口）

**Step 1: Fastify 服务**

- GET /api/sessions：query Store，返回 JSON
- GET /api/stats/overview：聚合 totalSessions、totalTokens、totalCost

**Step 2: 静态页面**

- 概览卡片：会话数、token、成本
- 会话列表表格：id、source、model、时间、token

**Step 3: 验证**

```bash
pnpm exec tsx packages/web/src/server.ts
# 浏览器访问 localhost:3847
```

**Step 4: Commit**

```bash
git add packages/web
git commit -m "feat(web): add minimal API and dashboard"
```

---

## Task 9: CLI - serve 命令

**Files:**
- Modify: `packages/cli/src/index.ts`

**Step 1: serve 命令**

- 启动 Web 服务（可复用 packages/web 的 server）
- 启动后台 Collector 轮询（如每 60 秒）
- 支持 `--port 3847`

**Step 2: 验证**

```bash
ai-hud serve
# 浏览器访问，确认数据刷新
```

**Step 3: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add serve command with background collection"
```

---

## Task 10: 根入口与 bin 配置

**Files:**
- Modify: `packages/cli/package.json`（bin 指向 dist）
- Create: `packages/cli/src/cli.ts`（若需分离）
- Modify: 根 package.json（workspace 脚本）

**Step 1: 配置 bin**

确保 `pnpm add -g .` 或 `pnpm link --global` 后，`ai-hud` 命令可用。

**Step 2: 验证**

```bash
pnpm build
pnpm --filter ai-hud exec node dist/index.js status
```

**Step 3: Commit**

```bash
git add .
git commit -m "chore: wire CLI bin and build scripts"
```

---

## 验收清单（Phase 1）

- [ ] `ai-hud collect` 能解析 OpenCode 并写入 SQLite
- [ ] `ai-hud status` 能输出最近会话
- [ ] `ai-hud serve` 能启动 Web，展示概览和会话列表
- [ ] 单 Adapter 失败不影响其他 Adapter

---

## 执行选项

**Plan complete and saved to `docs/plans/2025-03-18-ai-hud-phase1-implementation.md`.**

**两种执行方式：**

1. **Subagent-Driven（本会话）** — 按任务派发子 agent，任务间做代码评审，快速迭代
2. **Parallel Session（新会话）** — 在新会话中用 executing-plans，分批执行并设置检查点

**选哪种？**
