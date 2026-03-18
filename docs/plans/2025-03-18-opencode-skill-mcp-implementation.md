# OpenCode Skill/MCP 采集实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 OpenCode 流式采集中增加 skill 与 MCP 的采集，从 tool_use 分类工具、从 opencode.json 读取 MCP 配置、从 .opencode/skills/ 扫描 skill 列表。

**Architecture:** 在 adapters/opencode 中新增 opencode-config.ts（配置解析）和 skills-scanner.ts（目录扫描），修改 index.ts 的 runWithCapture：step_start 时加载配置与 skills，tool_use 时按内置/MCP 分类并更新 mcp 集合，step_finish 时写入完整 Session。

**Tech Stack:** Node.js 18+, TypeScript, fs/path 读取文件，strip-json-comments 或正则处理 JSONC

---

## Task 1: 内置工具白名单与 MCP 推断

**Files:**
- Create: `packages/adapters/src/opencode/constants.ts`
- Modify: `packages/adapters/src/opencode/index.ts`

**Step 1: 创建 constants.ts**

```ts
export const BUILTIN_TOOLS = new Set([
  'bash', 'read', 'write', 'edit', 'grep', 'glob', 'list',
  'webfetch', 'websearch', 'task',
]);

export function inferMcpName(toolName: string): string {
  const first = toolName.split('_')[0];
  return first && first !== toolName ? first : 'mcp';
}
```

**Step 2: 在 index.ts 中引入并修改 tool_use 逻辑**

- 导入 `BUILTIN_TOOLS`、`inferMcpName`
- 新增 `mcpUsed: Set<string>` 变量（在 step_start 时初始化为空）
- tool_use 时：若 `BUILTIN_TOOLS.has(toolName)` 则只累加 tools；否则累加 tools 且 `mcpUsed.add(inferMcpName(toolName))`
- step_finish 时：将 `mcpUsed` 转为数组合并到 session.mcp（与配置中的 mcp 合并，见后续 Task）

**Step 3: Commit**

```bash
git add packages/adapters/src/opencode/constants.ts packages/adapters/src/opencode/index.ts
git commit -m "feat(adapters): add builtin/MCP tool classification"
```

---

## Task 2: OpenCode 配置解析

**Files:**
- Create: `packages/adapters/src/opencode/opencode-config.ts`
- Modify: `packages/adapters/package.json`（如需 strip-json-comments）

**Step 1: 安装 strip-json-comments（可选，用于 JSONC）**

```bash
cd packages/adapters && pnpm add strip-json-comments
```

**Step 2: 创建 opencode-config.ts**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import stripJsonComments from 'strip-json-comments';

export interface OpenCodeConfig {
  mcp?: Record<string, { enabled?: boolean }>;
}

function loadJson(path: string): OpenCodeConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const cleaned = stripJsonComments(raw);
    return JSON.parse(cleaned) as OpenCodeConfig;
  } catch {
    return null;
  }
}

function findProjectConfig(cwd: string): string | null {
  let dir = cwd;
  while (dir) {
    const p = join(dir, 'opencode.json');
    if (existsSync(p)) return p;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadMergedConfig(cwd: string): OpenCodeConfig {
  const globalPath = join(homedir(), '.config', 'opencode', 'opencode.json');
  const projectPath = findProjectConfig(cwd);
  const global = loadJson(globalPath) ?? {};
  const project = projectPath ? loadJson(projectPath) ?? {} : {};
  return {
    mcp: { ...global.mcp, ...project.mcp },
  };
}

export function getEnabledMcpServers(config: OpenCodeConfig): string[] {
  const mcp = config.mcp ?? {};
  return Object.entries(mcp)
    .filter(([, v]) => v?.enabled !== false)
    .map(([k]) => k);
}
```

**Step 3: Commit**

```bash
git add packages/adapters/src/opencode/opencode-config.ts packages/adapters/package.json pnpm-lock.yaml
git commit -m "feat(adapters): add OpenCode config parser"
```

---

## Task 3: Skills 目录扫描

**Files:**
- Create: `packages/adapters/src/opencode/skills-scanner.ts`

**Step 1: 创建 skills-scanner.ts**

```ts
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SKILL_EXT = ['.md', '.txt'];

function scanDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const names = readdirSync(dir);
    return names
      .filter((n) => SKILL_EXT.some((e) => n.endsWith(e)))
      .map((n) => n.replace(/\.(md|txt)$/i, ''));
  } catch {
    return [];
  }
}

export function scanSkills(cwd: string): string[] {
  const projectDir = join(cwd, '.opencode', 'skills');
  const globalDir = join(homedir(), '.config', 'opencode', 'skills');
  const project = scanDir(projectDir);
  const global = scanDir(globalDir);
  return [...new Set([...project, ...global])];
}
```

**Step 2: Commit**

```bash
git add packages/adapters/src/opencode/skills-scanner.ts
git commit -m "feat(adapters): add skills directory scanner"
```

---

## Task 4: 集成到 runWithCapture

**Files:**
- Modify: `packages/adapters/src/opencode/index.ts`

**Step 1: 在 runWithCapture 开头加载配置与 skills**

```ts
import { loadMergedConfig, getEnabledMcpServers } from './opencode-config.js';
import { scanSkills } from './skills-scanner.js';
import { BUILTIN_TOOLS, inferMcpName } from './constants.js';
```

在 spawn 之后、stdout.on 之前：

```ts
const workDir = cwd ?? process.cwd();
const config = loadMergedConfig(workDir);
const configMcp = getEnabledMcpServers(config);
const configSkills = scanSkills(workDir);
```

**Step 2: step_start 时初始化**

```ts
case 'step_start': {
  session = {
    id: ev.sessionID,
    source: 'opencode',
    startedAt: timestampToIso(ev.timestamp),
    ...(configSkills.length > 0 && { skills: [...configSkills] }),
    ...(configMcp.length > 0 && { mcp: [...configMcp] }),
  };
  tools = [];
  mcpUsed = new Set();
  break;
}
```

需在外部声明 `let mcpUsed: Set<string> = new Set();`（与 tools 同级）。

**Step 3: tool_use 时更新 mcpUsed**

（已在 Task 1 中实现）

**Step 4: step_finish 时合并 mcp**

```ts
const mcpList = [...new Set([...configMcp, ...mcpUsed])];
sessionToAppend = {
  // ...existing fields
  ...(mcpList.length > 0 && { mcp: mcpList }),
  ...(session?.skills?.length && { skills: session.skills }),
};
```

**Step 5: 验证**

```bash
pnpm build
pnpm run cli -- opencode run "echo hello"
pnpm run cli -- status
```

检查 Store 中 Session 是否包含 skills、mcp 字段（若项目无 opencode.json 和 skills 目录，可能为空数组）。

**Step 6: Commit**

```bash
git add packages/adapters/src/opencode/index.ts
git commit -m "feat(adapters): integrate skill/MCP collection into runWithCapture"
```

---

## 验收清单

- [ ] `ai-hud opencode run "任务"` 后，Session 的 `tools` 正确累加
- [ ] 非内置工具（如 MCP 工具）会出现在 `mcp` 数组中
- [ ] 存在 opencode.json 时，配置中的 MCP 服务名出现在 `mcp` 中
- [ ] 存在 .opencode/skills/ 时，skill 文件名出现在 `skills` 中
- [ ] 无配置/目录时，不报错，skills/mcp 为空或仅来自 tool_use

---

## 执行选项

**Plan complete and saved to `docs/plans/2025-03-18-opencode-skill-mcp-implementation.md`.**

**两种执行方式：**

1. **Subagent-Driven（本会话）** — 按任务派发子 agent，任务间做代码评审，快速迭代
2. **Parallel Session（新会话）** — 在新会话中使用 executing-plans，分批执行并设置检查点

**选哪种？**
