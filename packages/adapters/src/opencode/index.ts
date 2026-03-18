import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { Session, SessionStore } from '@ai-hud/core';
import type { ContextUsage, CostInfo, ToolUsage } from '@ai-hud/core';
import type { SessionAdapter } from '@ai-hud/core';
import { BUILTIN_TOOLS, inferMcpName } from './constants.js';
import { getEnabledMcpServers, loadMergedConfig } from './opencode-config.js';
import { scanSkills } from './skills-scanner.js';

interface OpenCodeSessionListItem {
  id: string;
  title?: string;
  created?: number;
  updated?: number;
  projectId?: string;
  directory?: string;
}

interface OpenCodeExportData {
  info?: {
    id?: string;
    directory?: string;
    time?: { created?: number; updated?: number };
  };
  messages?: Array<{
    info?: {
      role?: string;
      modelID?: string;
      providerID?: string;
      cost?: number;
      tokens?: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache?: { read?: number; write?: number };
      };
    };
    parts?: Array<{
      type?: string;
      text?: string;
      tool?: string;
      reason?: string;
      cost?: number;
      tokens?: {
        input?: number;
        output?: number;
        cache?: { read?: number; write?: number };
      };
    }>;
  }>;
}

interface StreamStepStart {
  type: 'step_start';
  timestamp: number;
  sessionID: string;
  part?: { snapshot?: string };
}

interface StreamToolUse {
  type: 'tool_use';
  sessionID: string;
  part?: { tool?: string };
}

interface StreamStepFinish {
  type: 'step_finish';
  timestamp: number;
  sessionID: string;
  part?: {
    reason?: string;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
}

type StreamEvent = StreamStepStart | StreamToolUse | StreamStepFinish;

function normalizeTimestamp(ts: number): number {
  if (ts <= 0) return ts;
  if (ts < 1e12) return ts * 1000;
  return ts;
}

function timestampToIso(ts: number): string {
  return new Date(normalizeTimestamp(ts)).toISOString();
}

function parseToolUsage(tools: ToolUsage[], toolName: string): ToolUsage[] {
  const existing = tools.find((t) => t.name === toolName);
  if (existing) {
    existing.count += 1;
    return tools;
  }
  return [...tools, { name: toolName, count: 1 }];
}

export async function runWithCapture(
  store: SessionStore,
  task: string,
  cwd?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const workDir = cwd ?? process.cwd();
    const config = loadMergedConfig(workDir);
    const configMcp = getEnabledMcpServers(config);
    const configSkills = scanSkills(workDir);

    const proc = spawn('opencode', ['run', '--format', 'json', task], {
      stdio: ['inherit', 'pipe', 'inherit'],
      cwd: workDir,
      windowsHide: true,
    });

    let session: Partial<Session> | null = null;
    let tools: ToolUsage[] = [];
    let mcpUsed = new Set<string>();
    let sessionToAppend: Session | null = null;

    const stdout = proc.stdout;
    if (!stdout) {
      proc.once('error', reject);
      proc.once('close', (code: number | null) => {
        if (code !== 0) reject(new Error(`opencode exited with code ${code}`));
        else resolve();
      });
      return;
    }

    let buf = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as StreamEvent;
          switch (ev.type) {
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
            case 'tool_use': {
              const toolName = ev.part?.tool;
              if (toolName) {
                tools = parseToolUsage(tools, toolName);
                if (!BUILTIN_TOOLS.has(toolName)) {
                  mcpUsed.add(inferMcpName(toolName));
                }
              }
              break;
            }
            case 'step_finish': {
              if (ev.part?.reason === 'stop' && session) {
                const tokens = ev.part.tokens;
                const contextUsage: ContextUsage | undefined =
                  tokens != null
                    ? {
                        inputTokens: tokens.input ?? 0,
                        outputTokens: tokens.output ?? 0,
                        ...(tokens.cache?.read != null && {
                          cacheRead: tokens.cache.read,
                        }),
                        ...(tokens.cache?.write != null && {
                          cacheCreate: tokens.cache.write,
                        }),
                      }
                    : undefined;

                const cost: CostInfo | undefined =
                  ev.part.cost != null
                    ? { amount: ev.part.cost, currency: 'USD' }
                    : undefined;

                const mcpList = [...new Set([...configMcp, ...mcpUsed])];
                sessionToAppend = {
                  id: session.id!,
                  source: session.source!,
                  startedAt: session.startedAt!,
                  endedAt: timestampToIso(ev.timestamp),
                  prompt: task,
                  ...(contextUsage && { contextUsage }),
                  ...(tools.length > 0 && { tools }),
                  ...(cost && { cost }),
                  ...(session.skills?.length && { skills: session.skills }),
                  ...(mcpList.length > 0 && { mcp: mcpList }),
                };
              }
              break;
            }
          }
        } catch {
          // skip non-JSON lines
        }
      }
    });

    proc.once('error', reject);
    proc.once('close', async (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`opencode exited with code ${code}`));
        return;
      }
      if (sessionToAppend) {
        try {
          await store.append(sessionToAppend);
        } catch (err) {
          reject(err);
          return;
        }
      }
      resolve();
    });
  });
}

function getOpenCodeProjectDirs(): string[] {
  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) {
    return [homedir(), process.cwd()];
  }
  const result = spawnSync('sqlite3', [dbPath, 'SELECT worktree FROM project'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout?.trim()) {
    return [homedir(), process.cwd()];
  }
  const worktrees = result.stdout.trim().split('\n').filter(Boolean);
  const dirs = new Set<string>();
  dirs.add(homedir());
  dirs.add(process.cwd());
  for (const w of worktrees) {
    const d = w === '/' ? homedir() : w;
    if (d && existsSync(d)) dirs.add(d);
  }
  return [...dirs];
}

export class OpenCodeAdapter implements SessionAdapter {
  readonly name = 'opencode';

  async isAvailable(): Promise<boolean> {
    const result = spawnSync('opencode', ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.status === 0;
  }

  async collect(store: SessionStore): Promise<Session[]> {
    const dirsToTry = getOpenCodeProjectDirs();
    const seenIds = new Set<string>();
    const items: OpenCodeSessionListItem[] = [];

    for (const cwd of dirsToTry) {
      const listResult = spawnSync(
        'opencode',
        ['session', 'list', '--format', 'json', '--max-count', '100'],
        { encoding: 'utf8', windowsHide: true, cwd }
      );
      if (listResult.status !== 0 || !listResult.stdout?.trim()) continue;
      try {
        const parsed = JSON.parse(listResult.stdout) as OpenCodeSessionListItem[];
        if (Array.isArray(parsed)) {
          for (const it of parsed) {
            if (it.id && !seenIds.has(it.id)) {
              seenIds.add(it.id);
              items.push(it);
            }
          }
        }
      } catch {
        // skip
      }
    }

    if (items.length === 0) return [];

    const sessions: Session[] = [];
    for (const item of items) {
      if (!item.id) continue;
      const existing = await store.getById(item.id);
      if (existing != null) continue;

      const exportResult = spawnSync('opencode', ['export', item.id], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (exportResult.status !== 0 || !exportResult.stdout?.trim()) continue;

      let data: OpenCodeExportData;
      try {
        data = JSON.parse(exportResult.stdout) as OpenCodeExportData;
      } catch {
        continue;
      }

      const info = data.info;
      if (!info?.id) continue;

      const workDir = info.directory ?? item.directory ?? process.cwd();
      const config = loadMergedConfig(workDir);
      const configMcp = getEnabledMcpServers(config);
      const configSkills = scanSkills(workDir);

      const created = normalizeTimestamp(
        info.time?.created ?? item.created ?? 0
      );
      const updated = normalizeTimestamp(
        info.time?.updated ?? item.updated ?? created
      );

      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalCost = 0;
      const toolsMap = new Map<string, number>();
      const mcpUsed = new Set<string>(configMcp);
      let lastModel: string | undefined;
      let prompt: string | undefined;

      for (const msg of data.messages ?? []) {
        const mi = msg.info;
        if (mi?.role === 'user' && !prompt) {
          for (const part of msg.parts ?? []) {
            if (part.type === 'text' && part.text) {
              prompt = part.text.trim();
              if (prompt.length > 500) prompt = prompt.slice(0, 500) + '...';
              break;
            }
          }
        }
        if (mi?.tokens) {
          totalInput += mi.tokens.input ?? 0;
          totalOutput += mi.tokens.output ?? 0;
          const c = mi.tokens.cache;
          if (c) {
            totalCacheRead += c.read ?? 0;
            totalCacheWrite += c.write ?? 0;
          }
        }
        if (typeof mi?.cost === 'number') totalCost += mi.cost;
        if (mi?.modelID) lastModel = mi.modelID;

        for (const part of msg.parts ?? []) {
          if (part.type === 'tool' && part.tool) {
            toolsMap.set(part.tool, (toolsMap.get(part.tool) ?? 0) + 1);
            if (!BUILTIN_TOOLS.has(part.tool)) {
              mcpUsed.add(inferMcpName(part.tool));
            }
          }
        }
      }

      const contextUsage: ContextUsage | undefined =
        totalInput > 0 || totalOutput > 0
          ? {
              inputTokens: totalInput,
              outputTokens: totalOutput,
              ...(totalCacheRead > 0 && { cacheRead: totalCacheRead }),
              ...(totalCacheWrite > 0 && { cacheCreate: totalCacheWrite }),
            }
          : undefined;

      const tools: ToolUsage[] = Array.from(toolsMap.entries()).map(
        ([name, count]) => ({ name, count })
      );

      sessions.push({
        id: info.id,
        source: 'opencode',
        startedAt: new Date(created).toISOString(),
        endedAt: new Date(updated).toISOString(),
        ...(info.directory && { projectPath: info.directory }),
        ...(lastModel && { model: lastModel }),
        ...(prompt && { prompt }),
        ...(contextUsage && { contextUsage }),
        ...(tools.length > 0 && { tools }),
        ...(configSkills.length > 0 && { skills: configSkills }),
        ...(mcpUsed.size > 0 && { mcp: [...mcpUsed] }),
        ...(totalCost > 0 && { cost: { amount: totalCost, currency: 'USD' } }),
      });
    }
    return sessions;
  }
}
