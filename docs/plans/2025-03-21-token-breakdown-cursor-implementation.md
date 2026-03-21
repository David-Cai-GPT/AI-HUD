# Token 细分展示与 Cursor 适配 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 token 展示中支持按角色（system/user/assistant）和技术维度（input/output/cache）区分，并在 Web 会话详情中按数据可用性智能展示；实现 Cursor 被动采集 adapter。

**Architecture:** 扩展 ContextUsage 和 sessions 表，OpenCode export 按 role 聚合，Web 会话详情条件渲染 token 细分；新建 CursorAdapter 扫描 `~/Library/Application Support/Cursor/User/workspaceStorage` 下的 state.vscdb，解析 chat 数据并映射为 Session。

**Tech Stack:** Node.js 18+, TypeScript, sql.js, fs/path

---

## Task 1: 扩展 ContextUsage 与 SQLite 存储

**Files:**
- Modify: `packages/core/src/model/session.ts`
- Modify: `packages/core/src/store/sqlite-store.ts`

**Step 1: 扩展 ContextUsage 接口**

在 `packages/core/src/model/session.ts` 的 `ContextUsage` 中新增可选字段：

```ts
export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreate?: number;
  systemTokens?: number;
  userTokens?: number;
  assistantTokens?: number;
}
```

**Step 2: 扩展 SQLite 表与读写逻辑**

在 `packages/core/src/store/sqlite-store.ts` 中：

- 在 `CREATE_TABLE_SQL` 末尾、`);` 前加入三列（若使用独立 migration，则新增 `ALTER TABLE` 逻辑）：

在 `CREATE_TABLE_SQL` 的 sessions 表定义中，在 `cache_create INTEGER` 后增加三列：

```
  system_tokens INTEGER,
  user_tokens INTEGER,
  assistant_tokens INTEGER,
```

- 修改 `sessionToRow`：增加 `system_tokens`、`user_tokens`、`assistant_tokens` 的读写
- 修改 `rowToSession`：从 row 解析上述三列并入 `contextUsage`
- 修改 `append` 的 INSERT 语句：增加三列及占位符

**注意**：已有数据库需 migration。在 `doInit` 中 CREATE TABLE 之后执行：

```ts
// 兼容旧库：若缺少列则添加
const cols = this.db!.exec("PRAGMA table_info(sessions)");
const colNames = (cols[0]?.values ?? []).map((r: unknown[]) => String(r?.[1]));
for (const col of ['system_tokens', 'user_tokens', 'assistant_tokens']) {
  if (!colNames.includes(col)) {
    this.db!.run(`ALTER TABLE sessions ADD COLUMN ${col} INTEGER`);
  }
}
```

**Step 3: Commit**

```bash
git add packages/core/src/model/session.ts packages/core/src/store/sqlite-store.ts
git commit -m "feat(core): add role-based token fields to ContextUsage and sessions table"
```

---

## Task 2: OpenCode export 按 role 聚合 token

**Files:**
- Modify: `packages/adapters/src/opencode/index.ts`

**Step 1: 在被动 export 采集循环中累加 role 维度**

在遍历 `data.messages` 的 for 循环内，除已有 `totalInput`、`totalOutput`、`totalCacheRead`、`totalCacheWrite` 外，新增：

```ts
let totalSystem = 0;
let totalUser = 0;
let totalAssistant = 0;
```

在 `if (mi?.tokens)` 分支中，按 `mi.role` 累加：

```ts
const role = mi.role ?? '';
const ti = mi.tokens.input ?? 0;
const to = mi.tokens.output ?? 0;
if (role === 'system') totalSystem += ti + to;
else if (role === 'user') totalUser += ti + to;
else if (role === 'assistant') totalAssistant += ti + to;
// 原有 totalInput/totalOutput 累加保持不变
totalInput += ti;
totalOutput += to;
```

**Step 2: 将 role 聚合结果写入 contextUsage**

在构建 `contextUsage` 时，增加可选 role 字段：

```ts
const contextUsage: ContextUsage | undefined =
  totalInput > 0 || totalOutput > 0
    ? {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        ...(totalCacheRead > 0 && { cacheRead: totalCacheRead }),
        ...(totalCacheWrite > 0 && { cacheCreate: totalCacheWrite }),
        ...(totalSystem > 0 && { systemTokens: totalSystem }),
        ...(totalUser > 0 && { userTokens: totalUser }),
        ...(totalAssistant > 0 && { assistantTokens: totalAssistant }),
      }
    : undefined;
```

**Step 3: Commit**

```bash
git add packages/adapters/src/opencode/index.ts
git commit -m "feat(adapters): aggregate role-based tokens in OpenCode export"
```

---

## Task 3: Web 会话详情页 token 细分展示

**Files:**
- Modify: `packages/web/public/session.html`

**Step 1: 增加 token 细分区域**

在「基本信息」卡片的 meta 区域下方（或单独一个 card），增加 token 细分展示。逻辑：

- 总 token 保持：`inputTokens + outputTokens + (cacheRead ?? 0) + (cacheCreate ?? 0)` 或简化为 `input + output`
- 若有 `systemTokens ?? userTokens ?? assistantTokens` 任一非零，则额外展示「Token 细分」区块：
  - System / User / Assistant / Output
  - 若有 cacheRead 或 cacheCreate，也一并展示

示例 HTML 片段（插入到基本信息 card 的 `</div>` 之前）：

```html
${(s.contextUsage?.systemTokens ?? 0) + (s.contextUsage?.userTokens ?? 0) + (s.contextUsage?.assistantTokens ?? 0) > 0 ? `
<div class="meta" style="margin-top:12px; padding-top:12px; border-top:1px solid #eee;">
  <div class="meta-item"><span class="label">System</span><br><span class="val">${(s.contextUsage?.systemTokens ?? 0).toLocaleString()}</span></div>
  <div class="meta-item"><span class="label">User</span><br><span class="val">${(s.contextUsage?.userTokens ?? 0).toLocaleString()}</span></div>
  <div class="meta-item"><span class="label">Assistant</span><br><span class="val">${(s.contextUsage?.assistantTokens ?? 0).toLocaleString()}</span></div>
  <div class="meta-item"><span class="label">Output</span><br><span class="val">${(s.contextUsage?.outputTokens ?? 0).toLocaleString()}</span></div>
  ${(s.contextUsage?.cacheRead ?? 0) > 0 ? `<div class="meta-item"><span class="label">Cache Read</span><br><span class="val">${(s.contextUsage.cacheRead ?? 0).toLocaleString()}</span></div>` : ''}
  ${(s.contextUsage?.cacheCreate ?? 0) > 0 ? `<div class="meta-item"><span class="label">Cache Create</span><br><span class="val">${(s.contextUsage.cacheCreate ?? 0).toLocaleString()}</span></div>` : ''}
</div>
` : (s.contextUsage?.cacheRead ?? 0) + (s.contextUsage?.cacheCreate ?? 0) > 0 ? `
<div class="meta" style="margin-top:12px; padding-top:12px; border-top:1px solid #eee;">
  <div class="meta-item"><span class="label">Input</span><br><span class="val">${(s.contextUsage?.inputTokens ?? 0).toLocaleString()}</span></div>
  <div class="meta-item"><span class="label">Output</span><br><span class="val">${(s.contextUsage?.outputTokens ?? 0).toLocaleString()}</span></div>
  <div class="meta-item"><span class="label">Cache Read</span><br><span class="val">${(s.contextUsage?.cacheRead ?? 0).toLocaleString()}</span></div>
  <div class="meta-item"><span class="label">Cache Create</span><br><span class="val">${(s.contextUsage?.cacheCreate ?? 0).toLocaleString()}</span></div>
</div>
` : ''}
```

（可根据实际模板结构调整，保证条件渲染：有 role 时展示 role 细分，否则有 cache 时展示 input/output/cache。）

**Step 2: Commit**

```bash
git add packages/web/public/session.html
git commit -m "feat(web): show token breakdown by role and cache in session detail"
```

---

## Task 4: Cursor Adapter 实现

**Files:**
- Create: `packages/adapters/src/cursor/index.ts`
- Modify: `packages/adapters/src/index.ts`

**Step 1: 实现 CursorAdapter**

在 `packages/adapters/src/cursor/index.ts` 中实现 `CursorAdapter`，实现 `SessionAdapter` 接口。

- `name = 'cursor'`
- `isAvailable()`: 检测 `~/Library/Application Support/Cursor` 是否存在（`process.platform === 'darwin'` 时使用该路径）
- `collect(store)`: 调用 `collectFromLocalStorage(store)`，返回 Session 数组

**collectFromLocalStorage 逻辑：**

1. 扫描 `~/Library/Application Support/Cursor/User/workspaceStorage` 下所有子目录
2. 对每个子目录，检查 `state.vscdb` 是否存在
3. 使用 sql.js 或 `better-sqlite3` 打开并查询 `ItemTable` 中 key 包含 `aichat` 或 `chatdata` 或 `prompts` 的条目（实际 key 以 Cursor 版本为准，实现时需本地验证）
4. 解析 value（通常为 JSON），提取 conversation/chat 结构，映射为 Session
5. 对每个 Session 调用 `store.getById(id)` 判重，仅返回未入库的
6. 若某个 state.vscdb 读取失败，catch 后 log 并跳过，继续处理其他

**Session 映射要点：**

- `id`: 优先使用 Cursor 的 conversationId 或类似字段；若无则 `cursor:${workspaceHash}:${timestamp}`
- `source`: `'cursor'`
- `startedAt` / `endedAt`: 从 chat 时间戳转换
- `projectPath`: 可从 workspace 路径推断
- `contextUsage`: 若 Cursor 的 chat 中有 token/usage 字段则映射；否则留空

**TODO 标注**：若 Cursor 的 state.vscdb 实际 key 或 JSON 结构与上述假设不符，需在实现时根据真实结构调整解析逻辑。

**Step 2: 依赖**

- 若使用 sql.js：core 已用 sql.js，adapters 可依赖 core 或直接用 node 的 `child_process` 调用 `sqlite3` 命令行（避免在 browser 环境用 sql.js 的包袱）。推荐：新建 `packages/adapters/package.json` 依赖 `@ai-hud/core`，用 `better-sqlite3` 或 `sql.js` 读 state.vscdb。若项目倾向无原生依赖，可用 `sql.js`。
- 检查 `packages/adapters/package.json`：若无 sql.js，可 add `sql.js` 或使用 Node 内置能力 + 执行 `sqlite3` 子进程。

**Step 3: 导出 CursorAdapter**

在 `packages/adapters/src/index.ts` 中：

```ts
export { CursorAdapter } from './cursor/index.js';
```

**Step 4: Commit**

```bash
git add packages/adapters/src/cursor/index.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): add CursorAdapter with local storage scanning"
```

---

## Task 5: 注册 CursorAdapter 到 Collector

**Files:**
- Modify: `packages/cli/src/index.ts`

**Step 1: 引入并注册**

在 `collect` 和 `serve` 命令中，将 adapter 数组从 `[new OpenCodeAdapter()]` 改为：

```ts
import { OpenCodeAdapter, CursorAdapter } from '@ai-hud/adapters';

// ...
const collector = new Collector(store, [
  new OpenCodeAdapter(),
  new CursorAdapter(),
]);
```

**Step 2: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "feat(cli): register CursorAdapter in Collector"
```

---

## 实现说明

- **Cursor state.vscdb 结构**：实现 Task 4 前，建议先在本地执行 `sqlite3 ~/Library/Application\ Support/Cursor/User/workspaceStorage/<某uuid>/state.vscdb "SELECT key FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%aichat%'"` 确认实际 key 与 value 结构，再编写解析逻辑。
- **Windows**：首版仅在 macOS 启用 Cursor 扫描，`isAvailable` 中可加 `process.platform !== 'darwin'` 时直接 return false。
- **CLI token 细分**：按设计延后，本计划不实现。
