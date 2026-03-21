# Token 细分展示与 Cursor 适配 设计文档

> 设计日期：2025-03-21

## 概述

在 AI-HUD 中新增两项能力：

1. **Token 细分展示**：在 token 展示中区分用户 token、系统 token、assistant token 等不同形式，同时保留 input/output/cache 等技术维度
2. **Cursor 适配**：支持从 Cursor IDE 被动采集会话数据

**决策摘要**：
- Token：按角色（system/user/assistant）+ 技术维度（input/output/cache_read/cache_create）双维度支持；按来源智能展示
- Cursor：优先被动扫描本地 SQLite，预留 API 扩展点
- 展示：Web 优先，CLI 延后
- 数据不足时：仅展示有数据的维度

---

## 第一节：数据模型扩展（Token）

在 `ContextUsage` 中新增可选 role 拆分字段：

```
现有：inputTokens, outputTokens, cacheRead?, cacheCreate?
新增：systemTokens?, userTokens?, assistantTokens?（全部可选）
```

**存储**：sessions 表新增 `system_tokens`、`user_tokens`、`assistant_tokens` 列（可为 NULL）。

**展示逻辑**：仅当 `systemTokens ?? userTokens ?? assistantTokens` 至少有一个有值时，才在 Web 会话详情页展示 role 拆分列。

**OpenCode**：流式采集保持现状；export 采集时按 `message.info.role` 聚合填充 role 字段。

---

## 第二节：Cursor Adapter 架构与采集流程

**采集方式**：被动扫描

- **路径**：`~/Library/Application Support/Cursor/User/workspaceStorage/<uuid>/state.vscdb`
- **实现**：遍历 `workspaceStorage` 下各子目录，对每个 `state.vscdb` 执行 SQL 查询，解析 `ItemTable` 中与 chat 相关的 key
- **Session 映射**：从 chat 结构提取 id、时间、项目路径、消息等，映射为统一 `Session`，尽可能填充 `contextUsage`（若 Cursor 提供 token 信息）

**扩展点**：`CursorAdapter` 内部用「数据源」抽象（`collectFromLocalStorage()` + 预留 `collectFromApi?()`），Collector 只调 `adapter.collect()`。

**去重**：通过 `store.getById(sessionId)` 判重。Session id 优先使用 Cursor 的 chat/conversation id；若无则用 `cursor:<workspaceHash>:<timestamp>` 生成。

**可用性**：`isAvailable()` 检测 `~/Library/Application Support/Cursor` 目录是否存在。

---

## 第三节：Web 展示与 OpenCode 改造

**Web**：
- 概览、会话列表：保持现有总 token 展示
- 会话详情页：新增 token 细分。有 role 拆分时展示 System/User/Assistant/Output/Cache Read/Cache Create；无则只展示 Input/Output/Cache

**OpenCode**：
- 流式采集：不改动
- export 采集：按 `msg.info?.role` 分类累加 `systemTokens`、`userTokens`、`assistantTokens`

**Cursor**：若 chat 中有 token 信息则映射；否则 `contextUsage` 留空。

---

## 第四节：错误处理与实现注意点

- **Cursor 扫描**：单个 `state.vscdb` 损坏时记录日志并跳过，继续处理其他
- **SQLite 查询**：try-catch，失败返回空数组
- **Cursor schema 调研**：实现前需实际查看 `state.vscdb` 结构，以实际格式为准
- **macOS 路径**：首版支持 `~/Library/Application Support/Cursor`；Windows 延后
- **Collector**：注册 `CursorAdapter` 参与轮询

**YAGNI**：CLI token 细分、Cursor API 接入、Windows 路径，均不在首版实现。
