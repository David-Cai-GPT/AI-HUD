# OpenCode Skill / MCP 采集设计

> 设计日期：2025-03-18

## 概述

在 AI-HUD 现有 OpenCode 流式采集基础上，增加对「模型调用了哪些 skill」和「MCP 能力」的采集。支持：

1. **MCP 工具调用**：从 `tool_use` 事件区分内置工具与 MCP 工具，记录调用
2. **Skill 生效情况**：从配置与目录扫描获取会话中可用的 skill
3. **配置层面的 skill/MCP**：读取 opencode.json 中的 MCP 配置、扫描 `.opencode/skills/` 目录

**优先级**：仅 OpenCode，Cursor / Claude Code 后续扩展。

---

## 第一节：数据流与字段映射

### 1.1 数据来源与目标字段

| 来源 | 目标字段 | 说明 |
|------|----------|------|
| `tool_use` 且为内置工具 | `tools` | 累加 name + count |
| `tool_use` 且为 MCP 工具 | `tools` + `mcp` | tools 累加；mcp 去重追加工具所属 MCP 名 |
| `opencode.json` → `mcp` | `mcp` | 配置中启用的 MCP 服务名，与调用合并去重 |
| `.opencode/skills/` 或 `~/.config/opencode/skills/` | `skills` | 目录下的文件名（不含扩展名）作为 skill 名 |

### 1.2 内置工具白名单

```ts
const BUILTIN_TOOLS = new Set([
  'bash', 'read', 'write', 'edit', 'grep', 'glob', 'list',
  'webfetch', 'websearch', 'task'
]);
```

不在白名单内的 `part.tool` 视为 MCP 工具。MCP 工具名可能带前缀（如 `mcp_web_fetch`、`context7_xxx`），从工具名推断 MCP 服务名：取首段（`_` 前）或统一记为 `"mcp"`。

### 1.3 配置读取策略

- 项目配置：`cwd` 下的 `opencode.json`，或向上查找最近 Git 根目录
- 全局配置：`~/.config/opencode/opencode.json`
- 合并：项目配置覆盖全局配置中同名字段

---

## 第二节：实现细节

### 2.1 修改范围

| 文件 | 改动 |
|------|------|
| `packages/adapters/src/opencode/index.ts` | 新增工具分类、配置读取、skills 目录扫描 |
| `packages/adapters/src/opencode/opencode-config.ts` | 新建：解析 opencode.json、合并配置 |
| `packages/adapters/src/opencode/skills-scanner.ts` | 新建：扫描 `.opencode/skills/` 目录 |

### 2.2 工具分类逻辑

```ts
// tool_use 时
if (BUILTIN_TOOLS.has(toolName)) {
  tools = parseToolUsage(tools, toolName);
} else {
  tools = parseToolUsage(tools, toolName);
  mcpUsed.add(inferMcpName(toolName)); // 如 mcp_web_fetch → "mcp" 或取首段
}
```

`inferMcpName`：若工具名含 `_`，取首段作为 MCP 名；否则用 `"mcp"`。最终 `mcp` 数组 = 配置中的 mcp keys ∪ `mcpUsed`，去重。

### 2.3 配置解析

- 支持 JSON 和 JSONC（strip 注释后解析）
- `mcp` 结构：`{ "serverName": { "enabled"?: boolean, ... } }`，取 `enabled !== false` 的 key
- 路径：项目 `opencode.json`（cwd 向上找）、`~/.config/opencode/opencode.json`
- 失败：文件不存在或解析失败时返回空对象，不中断流程

### 2.4 Skills 目录扫描

- 扫描：`<cwd>/.opencode/skills/`、`~/.config/opencode/skills/`
- 取 `.md` 或 `.txt` 文件名（不含扩展名）作为 skill 名
- 去重后合并

### 2.5 Session 写入时机

- `step_start`：创建 Session，注入 `skills`、`mcp`（来自配置）
- `tool_use`：更新 `tools`，若为 MCP 则更新 `mcp`
- `step_finish`（reason=stop）：写入最终 Session

---

## 第三节：错误处理与展示

### 3.1 错误处理

| 场景 | 处理方式 |
|------|----------|
| opencode.json 不存在 | 跳过配置，skills/mcp 仅来自 tool_use 和 skills 目录 |
| opencode.json 解析失败 | 记录 warn，跳过配置 |
| skills 目录不存在 | 返回空数组 |
| tool 名未知/空 | 忽略该 tool_use |
| JSONC 注释 | 用正则或 strip-json-comments 去除后解析 |

### 3.2 边界情况

- **无 MCP 调用**：`mcp` 仅包含配置中的服务名（表示「已启用」）
- **无配置**：`skills` 来自目录扫描，`mcp` 仅来自 tool_use 推断
- **cwd 变化**：`runWithCapture` 的 cwd 决定项目配置和 `.opencode/skills/` 的查找路径

### 3.3 Web 仪表盘展示

- **会话详情**：已有 `skills`、`mcp` 字段，在详情页展示
- **工具统计**：`tools` 已支持，可增加「MCP 工具 vs 内置工具」的区分展示（可选）

### 3.4 向后兼容

- 现有 Session 的 `skills`、`mcp` 为 `undefined` 或 `[]` 时，展示为空
- Store 与 API 无需改动，沿用 `raw_meta` 中的 JSON 存储

---

## 附录：需求确认摘要

- 使用场景：调用记录 + 配置信息，全部都要
- 优先级：OpenCode 优先
- Skill 获取：尽量推断，若 OpenCode 有 skill 相关输出则解析，否则从配置/目录推断
- 方案：方案 B（tool_use 分类 + 配置读取）
