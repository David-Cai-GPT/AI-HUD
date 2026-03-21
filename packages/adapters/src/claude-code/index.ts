import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session, SessionStore } from '@ai-hud/core';
import type { ContextUsage, CostInfo, ToolUsage } from '@ai-hud/core';
import type { SessionAdapter } from '@ai-hud/core';

/** Claude Code session JSONL 单行结构（assistant 含 usage） */
interface ClaudeMessage {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | Array<{ type?: string; text?: string; name?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
  result?: { total_cost?: number };
}

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

/** 将目录名解码为项目路径，如 -home-user-project -> /home/user/project */
function decodeProjectPath(dirName: string): string {
  if (!dirName || dirName === '.') return '';
  const s = dirName.startsWith('-') ? dirName.slice(1) : dirName;
  return '/' + s.replace(/-/g, '/');
}

/** 递归收集指定目录下所有 .jsonl 文件路径 */
function collectJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        out.push(...collectJsonlFiles(full));
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  } catch {
    // skip
  }
  return out;
}

/** 解析单个 session 文件，提取 Session 所需字段 */
function parseSessionFile(
  filePath: string,
  projectPath: string
): Session | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;

  const sessionId = filePath.split(/[/\\]/).pop()?.replace(/\.jsonl$/, '') ?? '';
  const id = sessionId ? `claude:${sessionId}` : `claude:${Date.now()}`;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let prompt: string | undefined;
  let model: string | undefined;
  const toolsMap = new Map<string, number>();
  let totalCost = 0;

  for (const line of lines) {
    let msg: ClaudeMessage;
    try {
      msg = JSON.parse(line) as ClaudeMessage;
    } catch {
      continue;
    }
    const ts = msg.timestamp;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    if (msg.type === 'user' && msg.message && !prompt) {
      const c = msg.message.content;
      if (typeof c === 'string') {
        prompt = c.length > 500 ? c.slice(0, 500) + '...' : c;
      } else if (Array.isArray(c)) {
        const first = c.find((b) => b.type === 'text' && b.text);
        if (first && 'text' in first) {
          const t = String((first as { text?: string }).text ?? '');
          prompt = t.length > 500 ? t.slice(0, 500) + '...' : t;
        }
      }
    }

    if (msg.type === 'assistant' && msg.message) {
      const m = msg.message;
      if (m.model) model = m.model;
      const u = m.usage;
      if (u) {
        totalInput += u.input_tokens ?? 0;
        totalOutput += u.output_tokens ?? 0;
        totalCacheRead += u.cache_read_input_tokens ?? 0;
        const cc = u.cache_creation;
        if (cc) {
          totalCacheCreate += (cc.ephemeral_5m_input_tokens ?? 0) + (cc.ephemeral_1h_input_tokens ?? 0);
        }
      }
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b?.type === 'tool_use' && (b as { name?: string }).name) {
          const name = (b as { name: string }).name;
          toolsMap.set(name, (toolsMap.get(name) ?? 0) + 1);
        }
      }
    }

    if (msg.type === 'result' && msg.result?.total_cost != null) {
      totalCost = msg.result.total_cost;
    }
  }

  const startedAt = firstTs ?? new Date().toISOString();
  const endedAt = lastTs ?? startedAt;

  const contextUsage: ContextUsage | undefined =
    totalInput > 0 || totalOutput > 0
      ? {
          inputTokens: totalInput,
          outputTokens: totalOutput,
          ...(totalCacheRead > 0 && { cacheRead: totalCacheRead }),
          ...(totalCacheCreate > 0 && { cacheCreate: totalCacheCreate }),
        }
      : undefined;

  const tools: ToolUsage[] = Array.from(toolsMap.entries()).map(
    ([name, count]) => ({ name, count })
  );

  const cost: CostInfo | undefined =
    totalCost > 0 ? { amount: totalCost, currency: 'USD' } : undefined;

  return {
    id,
    source: 'claude-code',
    startedAt,
    endedAt,
    ...(projectPath && { projectPath }),
    ...(model && { model }),
    ...(prompt && { prompt }),
    ...(contextUsage && { contextUsage }),
    ...(tools.length > 0 && { tools }),
    ...(cost && { cost }),
  };
}

export class ClaudeCodeAdapter implements SessionAdapter {
  readonly name = 'claude-code';

  async isAvailable(): Promise<boolean> {
    return existsSync(CLAUDE_PROJECTS);
  }

  async collect(store: SessionStore): Promise<Session[]> {
    if (!existsSync(CLAUDE_PROJECTS)) return [];

    const sessions: Session[] = [];
    const projectDirs = readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: join(CLAUDE_PROJECTS, d.name) }));

    for (const { name: dirName, path: dirPath } of projectDirs) {
      const projectPath = decodeProjectPath(dirName);
      const jsonlFiles = collectJsonlFiles(dirPath);

      for (const fp of jsonlFiles) {
        try {
          const session = parseSessionFile(fp, projectPath);
          if (!session) continue;

          const existing = await store.getById(session.id);
          if (existing != null) continue;

          sessions.push(session);
        } catch (err) {
          console.error(`[ClaudeCodeAdapter] parse ${fp} failed:`, err);
        }
      }
    }

    return sessions;
  }
}
