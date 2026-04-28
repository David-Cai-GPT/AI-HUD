import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCodexActivitySnapshot, type CodexActivitySnapshot, type CodexSessionInfo } from './codex-activity.js';
import type { HarnessDiscoveryOptions, HarnessDiscoverer, HarnessProcess, HarnessState } from './types.js';

const execFileAsync = promisify(execFile);

interface PsRow {
  pid: number;
  parentPid: number;
  elapsedSeconds?: number;
  cpuPercent?: number;
  memoryPercent?: number;
  command: string;
}

const DEFAULT_KEYWORDS = [
  'codex',
  'claude',
  'claude-code',
  'opencode',
  'cursor',
  'aider',
  'continue',
  'hermes',
  'openclaw',
  'harness',
];

export class ProcessHarnessDiscoverer implements HarnessDiscoverer {
  async discover(options: HarnessDiscoveryOptions = {}): Promise<HarnessProcess[]> {
    const rows = await readProcesses();
    const keywords = normalizeKeywords(options.keywords ?? DEFAULT_KEYWORDS);
    const processes = rows
      .filter((row) => options.includeAll || matchesKeywords(row.command, keywords))
      .map(toHarnessProcess);

    await enrichWithRuntimeActivity(processes);

    return processes
      .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || a.pid - b.pid);
  }
}

async function enrichWithRuntimeActivity(processes: HarnessProcess[]): Promise<void> {
  if (!processes.some((process) => process.kind === 'codex')) return;

  const snapshot = await readCodexActivitySnapshot();
  const codexRoots = new Map<number, CodexSessionInfo | undefined>();

  for (const process of processes) {
    if (process.kind !== 'codex') continue;
    process.rootPid = findRootPid(process, processes);
    const session = getCodexSessionForRoot(process.rootPid, process.elapsedSeconds, snapshot, codexRoots);
    const activity = session
      ? snapshot.byThreadId.get(session.threadId) ?? snapshot.latest
      : snapshot.latest;
    if (!activity) continue;

    if (isCodexRuntimeProcess(process.command)) {
      process.currentAction = activity.summary;
    } else {
      process.currentAction = process.currentAction ?? 'Codex helper process';
    }
    process.activityAt = activity.timestamp;
    process.activityThreadId = session?.threadId ?? activity.threadId;
    if (activity.state && isCodexRuntimeProcess(process.command)) process.state = activity.state;
  }
}

function findRootPid(process: HarnessProcess, allProcesses: HarnessProcess[]): number {
  let current = process;
  const seen = new Set<number>();

  while (!seen.has(current.pid)) {
    seen.add(current.pid);
    const parent = allProcesses.find((candidate) => candidate.pid === current.parentPid && candidate.kind === current.kind);
    if (!parent) return current.pid;
    current = parent;
  }

  return process.pid;
}

function getCodexSessionForRoot(
  rootPid: number | undefined,
  elapsedSeconds: number | undefined,
  snapshot: CodexActivitySnapshot,
  cache: Map<number, CodexSessionInfo | undefined>
): CodexSessionInfo | undefined {
  if (rootPid == null) return undefined;
  if (cache.has(rootPid)) return cache.get(rootPid);

  const startedAt = elapsedSeconds == null ? undefined : Date.now() - elapsedSeconds * 1000;
  const session = startedAt == null ? snapshot.sessions[0] : findNearestSession(startedAt, snapshot.sessions);
  cache.set(rootPid, session);
  return session;
}

function findNearestSession(startedAt: number, sessions: CodexSessionInfo[]): CodexSessionInfo | undefined {
  let best: CodexSessionInfo | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const session of sessions) {
    if (!session.startedAt) continue;
    const distance = Math.abs(new Date(session.startedAt).getTime() - startedAt);
    if (distance < bestDistance) {
      best = session;
      bestDistance = distance;
    }
  }

  return best ?? sessions[0];
}

function isCodexRuntimeProcess(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.includes('@openai/codex') || lower.includes('/.local/bin/codex') || lower.includes('codex exec');
}

async function readProcesses(): Promise<PsRow[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,etime=,%cpu=,%mem=,command='], {
    maxBuffer: 1024 * 1024 * 4,
  });

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parsePsLine)
    .filter((row): row is PsRow => row != null);
}

function parsePsLine(line: string): PsRow | undefined {
  const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
  if (!match) return undefined;

  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    elapsedSeconds: parseElapsedTime(match[3]),
    cpuPercent: Number(match[4]),
    memoryPercent: Number(match[5]),
    command: match[6],
  };
}

function parseElapsedTime(value: string): number | undefined {
  const dayParts = value.split('-');
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const time = dayParts.length === 2 ? dayParts[1] : dayParts[0];
  const parts = time.split(':').map(Number);

  if (parts.some((part) => Number.isNaN(part))) return undefined;

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return days * 86400 + minutes * 60 + seconds;
  }

  return undefined;
}

function toHarnessProcess(row: PsRow): HarnessProcess {
  const name = detectName(row.command);
  const kind = detectKind(row.command, name);

  return {
    id: `${kind}:${row.pid}`,
    pid: row.pid,
    parentPid: row.parentPid,
    name,
    kind,
    command: row.command,
    state: detectState(row.command),
    elapsedSeconds: row.elapsedSeconds,
    cpuPercent: row.cpuPercent,
    memoryPercent: row.memoryPercent,
    currentAction: detectAction(row.command),
  };
}

function normalizeKeywords(keywords: string[]): string[] {
  return keywords.map((keyword) => keyword.toLowerCase()).filter(Boolean);
}

function matchesKeywords(command: string, keywords: string[]): boolean {
  const lower = command.toLowerCase();
  return keywords.some((keyword) => matchesKeyword(lower, keyword));
}

function matchesKeyword(command: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[/\\s._-])${escaped}([/\\s._-]|$)`, 'i').test(command);
}

function detectName(command: string): string {
  const executable = command.split(/\s+/)[0] ?? command;
  const basename = executable.split('/').pop() ?? executable;
  const lower = command.toLowerCase();

  if (lower.includes('claude-code')) return 'Claude Code';
  if (lower.includes('opencode')) return 'OpenCode';
  if (lower.includes('openclaw')) return 'OpenClaw';
  if (lower.includes('hermes')) return 'Hermes';
  if (lower.includes('codex')) return 'Codex';
  if (lower.includes('cursor')) return 'Cursor';
  if (lower.includes('aider')) return 'Aider';
  if (lower.includes('continue')) return 'Continue';

  return basename;
}

function detectKind(command: string, name: string): string {
  const normalized = name.toLowerCase().replace(/\s+/g, '-');
  if (normalized && normalized !== 'node' && normalized !== 'python' && normalized !== 'python3') {
    return normalized;
  }

  const lower = command.toLowerCase();
  for (const keyword of DEFAULT_KEYWORDS) {
    if (lower.includes(keyword)) return keyword;
  }

  return normalized || 'process';
}

function detectState(command: string): HarnessState {
  const lower = command.toLowerCase();
  if (lower.includes('error') || lower.includes('failed')) return 'failed';
  if (lower.includes('approval') || lower.includes('confirm') || lower.includes('stdin')) return 'waiting';
  if (lower.includes('openclaw-gateway')) return 'idle';
  if (lower.includes('serve') || lower.includes('daemon') || lower.includes('server')) return 'idle';
  return 'running';
}

function detectAction(command: string): string | undefined {
  const lower = command.toLowerCase();
  if (lower.includes('openclaw-gateway')) return 'serving OpenClaw gateway';
  if (lower.includes('openclaw')) return 'running OpenClaw process';
  if (lower.includes('/hermes') || lower.includes(' hermes')) return 'running Hermes agent';
  if (lower.includes('opencode run')) return 'running OpenCode task';
  if (lower.includes('codex exec')) return 'running Codex exec';
  if (lower.includes('serve') || lower.includes('server')) return 'serving dashboard/API';
  if (lower.includes('collect')) return 'collecting sessions';
  return undefined;
}
