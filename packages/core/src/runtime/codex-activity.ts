import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessState } from './types.js';

export interface RuntimeActivity {
  source: string;
  threadId?: string;
  summary: string;
  state?: HarnessState;
  timestamp?: string;
}

const DEFAULT_LOG_PATH = join(homedir(), '.codex', 'log', 'codex-tui.log');
const DEFAULT_SESSIONS_PATH = join(homedir(), '.codex', 'sessions');

export interface CodexSessionInfo {
  threadId: string;
  startedAt?: string;
  cwd?: string;
  path: string;
}

export interface CodexActivitySnapshot {
  latest?: RuntimeActivity;
  byThreadId: Map<string, RuntimeActivity>;
  sessions: CodexSessionInfo[];
}

export async function readCodexActivitySnapshot(options: {
  logPath?: string;
  sessionsPath?: string;
} = {}): Promise<CodexActivitySnapshot> {
  const byThreadId = await readCodexActivitiesByThread(options.logPath ?? DEFAULT_LOG_PATH);
  const latest = [...byThreadId.values()].sort(compareActivityDesc)[0];
  const sessions = await readCodexSessions(options.sessionsPath ?? DEFAULT_SESSIONS_PATH);

  return {
    latest,
    byThreadId,
    sessions,
  };
}

export async function readLatestCodexActivity(logPath = DEFAULT_LOG_PATH): Promise<RuntimeActivity | undefined> {
  const byThreadId = await readCodexActivitiesByThread(logPath);
  return [...byThreadId.values()].sort(compareActivityDesc)[0];
}

async function readCodexActivitiesByThread(logPath: string): Promise<Map<string, RuntimeActivity>> {
  let content: string;
  try {
    content = await readFile(logPath, 'utf8');
  } catch {
    return new Map();
  }

  const activities = new Map<string, RuntimeActivity>();
  const lines = content.split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const activity = parseCodexLogLine(lines[index]);
    if (!activity?.threadId || activities.has(activity.threadId)) continue;
    activities.set(activity.threadId, activity);
  }

  return activities;
}

async function readCodexSessions(sessionsPath: string): Promise<CodexSessionInfo[]> {
  const files = await listJsonlFiles(sessionsPath);
  const sessions: CodexSessionInfo[] = [];

  for (const path of files) {
    const info = await readCodexSessionInfo(path);
    if (info) sessions.push(info);
  }

  return sessions.sort((a, b) => toTime(b.startedAt) - toTime(a.startedAt));
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path);
    }
  }

  return files;
}

async function readCodexSessionInfo(path: string): Promise<CodexSessionInfo | undefined> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }

  const firstLine = content.split('\n').find(Boolean);
  if (!firstLine) return undefined;

  try {
    const parsed = JSON.parse(firstLine);
    const payload = isRecord(parsed?.payload) ? parsed.payload : undefined;
    const threadId = typeof payload?.id === 'string' ? payload.id : undefined;
    if (!threadId) return undefined;

    return {
      threadId,
      startedAt: typeof payload?.timestamp === 'string' ? payload.timestamp : undefined,
      cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
      path,
    };
  } catch {
    return undefined;
  }
}

function parseCodexLogLine(line: string): RuntimeActivity | undefined {
  const timestamp = line.match(/^(\S+)/)?.[1];
  const threadId = line.match(/thread_id=([a-f0-9-]+)/)?.[1] ?? line.match(/thread\.id=([a-f0-9-]+)/)?.[1];

  const toolCall = parseToolCall(line, timestamp, threadId);
  if (toolCall) return toolCall;

  if (line.includes('model_client.stream_responses_api') && line.includes(': new')) {
    const model = line.match(/model=([^\s}]+)/)?.[1];
    return {
      source: 'codex',
      threadId,
      timestamp,
      state: 'running',
      summary: model ? `thinking with ${model}` : 'thinking',
    };
  }

  if (line.includes('codex_core::tasks: close')) {
    return {
      source: 'codex',
      threadId,
      timestamp,
      state: 'waiting',
      summary: 'waiting for next input',
    };
  }

  return undefined;
}

function parseToolCall(line: string, timestamp: string | undefined, threadId: string | undefined): RuntimeActivity | undefined {
  const marker = 'ToolCall: ';
  const markerIndex = line.indexOf(marker);
  if (markerIndex < 0) return undefined;

  const rest = line.slice(markerIndex + marker.length);
  const firstSpace = rest.indexOf(' ');
  if (firstSpace < 0) return undefined;

  const toolName = rest.slice(0, firstSpace);
  const payload = parseFirstJsonObject(rest.slice(firstSpace + 1));
  const summary = summarizeToolCall(toolName, payload);

  return {
    source: 'codex',
    threadId,
    timestamp,
    state: 'running',
    summary,
  };
}

function parseFirstJsonObject(input: string): Record<string, unknown> | undefined {
  const start = input.indexOf('{');
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;

    if (depth === 0) {
      try {
        const parsed = JSON.parse(input.slice(start, index + 1));
        return isRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

function summarizeToolCall(toolName: string, payload: Record<string, unknown> | undefined): string {
  if (toolName === 'exec_command') {
    const cmd = typeof payload?.cmd === 'string' ? payload.cmd : undefined;
    return cmd ? `exec: ${cmd}` : 'exec command';
  }

  if (toolName === 'apply_patch') return 'editing files';

  if (toolName === 'view_image') {
    const path = typeof payload?.path === 'string' ? payload.path : undefined;
    return path ? `view image: ${path}` : 'viewing image';
  }

  return `tool: ${toolName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function compareActivityDesc(a: RuntimeActivity, b: RuntimeActivity): number {
  return toTime(b.timestamp) - toTime(a.timestamp);
}

function toTime(value: string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
