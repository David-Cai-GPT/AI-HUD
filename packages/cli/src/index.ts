#!/usr/bin/env node
import { Command } from 'commander';
import {
  Collector,
  ProcessHarnessDiscoverer,
  SqliteStore,
  type HarnessProcess,
  type Session,
} from '@ai-hud/core';
import { OpenCodeAdapter, CursorAdapter, ClaudeCodeAdapter, runWithCapture } from '@ai-hud/adapters';
import { startServer, DEFAULT_PORT } from '@ai-hud/web';

const program = new Command();

program
  .name('ai-hud')
  .description('AI-HUD: monitor and record AI coding tool sessions')
  .version('0.0.1');

program
  .command('collect')
  .description('Run collection once from all adapters')
  .action(async () => {
    const store = new SqliteStore();
    try {
      const collector = new Collector(store, [
        new OpenCodeAdapter(),
        new CursorAdapter(),
        new ClaudeCodeAdapter(),
      ]);
      await collector.run();
    } finally {
      store.close();
    }
  });

program
  .command('serve')
  .description('Start Web server with background collection')
  .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_PORT))
  .action(async function (this: { opts: () => { port?: string } }) {
    let portOpt = this.opts().port ?? String(DEFAULT_PORT);
    const portIdx = process.argv.indexOf('--port');
    if (portIdx >= 0 && process.argv[portIdx + 1]) {
      portOpt = process.argv[portIdx + 1];
    }
    const port = Math.max(1, parseInt(String(portOpt), 10) || DEFAULT_PORT);
    const store = new SqliteStore();
    await startServer(port, store);

    const collector = new Collector(store, [
      new OpenCodeAdapter(),
      new CursorAdapter(),
      new ClaudeCodeAdapter(),
    ]);
    await collector.run();
    setInterval(() => collector.run(), 60_000);
    console.log('后台采集已启动，每 60 秒执行一次');

    const shutdown = () => {
      store.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('status')
  .description('Show recent sessions summary')
  .option('-l, --limit <n>', 'Max number of sessions to show', '10')
  .action(async (opts: { limit: string }) => {
    const limit = Math.max(1, parseInt(opts.limit, 10) || 10);
    const store = new SqliteStore();
    try {
      const sessions = await store.query({ limit });
      if (sessions.length === 0) {
        console.log('暂无会话记录，请先执行 ai-hud collect 或 ai-hud opencode run');
        return;
      }
      printSessionsTable(sessions);
    } finally {
      store.close();
    }
  });

program
  .command('monitor')
  .description('Show live harness processes in a terminal dashboard')
  .option('--once', 'Render once and exit')
  .option('-i, --interval <seconds>', 'Refresh interval in seconds', '2')
  .option('-a, --all', 'Show all processes instead of AI harness matches')
  .option('-k, --keyword <keyword...>', 'Additional process keywords to match')
  .action(async (opts: { once?: boolean; interval: string; all?: boolean; keyword?: string[] }) => {
    const discoverer = new ProcessHarnessDiscoverer();
    const intervalMs = Math.max(500, (parseFloat(opts.interval) || 2) * 1000);
    const keywords = opts.keyword?.length ? opts.keyword : undefined;

    const render = async () => {
      const processes = await discoverer.discover({
        includeAll: Boolean(opts.all),
        keywords,
      });
      printMonitor(processes, { clear: !opts.once });
    };

    await render();
    if (opts.once) return;

    const timer = setInterval(() => {
      render().catch((err) => {
        console.error('monitor failed:', err);
      });
    }, intervalMs);

    const shutdown = () => {
      clearInterval(timer);
      process.stdout.write('\x1b[?25h');
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('session')
  .description('Session commands')
  .addCommand(
    new Command('show')
      .description('Show session detail by ID')
      .argument('<id>', 'Session ID (e.g. ses_xxx)')
      .action(async (id: string) => {
        const store = new SqliteStore();
        try {
          const session = await store.getById(id);
          if (!session) {
            console.error('会话不存在:', id);
            process.exit(1);
          }
          printSessionDetail(session);
        } finally {
          store.close();
        }
      })
  );

program
  .command('opencode')
  .description('OpenCode adapter commands')
  .addCommand(
    new Command('run')
      .description('Run OpenCode task and capture session to store')
      .argument('<task>', 'Task to run (e.g. "echo hello")')
      .option('-c, --cwd <path>', 'Working directory', process.cwd())
      .action(async (task: string, opts: { cwd?: string }) => {
        const store = new SqliteStore();
        try {
          await runWithCapture(store, task, opts.cwd);
        } finally {
          store.close();
        }
      })
  );

program.parse(sanitizeArgv(process.argv));

function printSessionsTable(sessions: Session[]): void {
  const W = { id: 10, source: 12, model: 16, time: 16, token: 10, cost: 14 };
  const pad = (s: string, w: number) => s.padEnd(w);
  const header =
    pad('ID', W.id) +
    pad('来源', W.source) +
    pad('模型', W.model) +
    pad('时间', W.time) +
    pad('Token', W.token) +
    pad('成本', W.cost);
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const s of sessions) {
    const id = s.id.length > 8 ? s.id.slice(0, 8) : s.id;
    const model = s.model ?? '-';
    const time = formatTime(s.startedAt);
    const token =
      s.contextUsage != null
        ? s.contextUsage.inputTokens + s.contextUsage.outputTokens
        : 0;
    const cost =
      s.cost != null ? `${s.cost.amount} ${s.cost.currency}` : '-';
    console.log(
      pad(id, W.id) +
        pad(s.source, W.source) +
        pad(model, W.model) +
        pad(time, W.time) +
        pad(String(token), W.token) +
        pad(cost, W.cost)
    );
  }
}

function printSessionDetail(s: Session): void {
  console.log('ID:', s.id);
  console.log('来源:', s.source);
  console.log('模型:', s.model ?? '-');
  console.log('开始:', s.startedAt);
  console.log('结束:', s.endedAt ?? '-');
  const tokens =
    (s.contextUsage?.inputTokens ?? 0) + (s.contextUsage?.outputTokens ?? 0);
  console.log('Token:', tokens.toLocaleString());
  console.log(
    '成本:',
    s.cost ? `${s.cost.amount} ${s.cost.currency}` : '-'
  );
  if (s.projectPath) console.log('项目路径:', s.projectPath);
  if (s.prompt) {
    console.log('\n用户输入 (Prompt):');
    console.log(s.prompt);
  }
  if (s.tools?.length) {
    console.log('\n工具调用:', s.tools.map((t) => `${t.name}×${t.count}`).join(', '));
  }
  if (s.skills?.length) {
    console.log('Skills:', s.skills.join(', '));
  }
  if (s.mcp?.length) {
    console.log('MCP:', s.mcp.join(', '));
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch {
    return iso;
  }
}

function sanitizeArgv(argv: string[]): string[] {
  const separatorIndex = argv.indexOf('--', 2);
  if (separatorIndex < 0) return argv;
  return [...argv.slice(0, separatorIndex), ...argv.slice(separatorIndex + 1)];
}

function printMonitor(processes: HarnessProcess[], options: { clear: boolean }): void {
  const terminalWidth = process.stdout.columns || 120;
  if (options.clear) {
    process.stdout.write('\x1b[?25l\x1b[2J\x1b[H');
  }

  const now = new Date();
  const groups = groupByRoot(processes);
  const summary = summarizeProcesses(processes);
  const width = Math.max(80, terminalWidth);

  console.log(color('AI-HUD', 'cyan', true) + color(' live harness monitor', 'dim'));
  console.log(
    [
      badge(`${processes.length} proc`, 'cyan'),
      badge(`${groups.length} session`, 'magenta'),
      statusBadge('running', summary.running),
      statusBadge('waiting', summary.waiting),
      statusBadge('failed', summary.failed),
      color(`refreshed ${formatClock(now)}`, 'dim'),
    ].filter(Boolean).join('  ')
  );
  console.log(color('─'.repeat(Math.min(width, 140)), 'dim'));

  if (processes.length === 0) {
    console.log(color('No matching harness processes found.', 'yellow'));
    console.log(color('Try: ai-hud monitor --all or ai-hud monitor -k codex claude opencode', 'dim'));
    return;
  }

  const widths = computeMonitorWidths(terminalWidth);
  const header =
    pad('', widths.gutter) +
    pad('PID', widths.pid) +
    pad('Root', widths.root) +
    pad('Tool', widths.tool) +
    pad('State', widths.state) +
    pad('Age', widths.age) +
    pad('CPU', widths.cpu) +
    pad('MEM', widths.mem) +
    pad('Activity', widths.command);

  console.log(color(header, 'dim'));
  console.log(color('─'.repeat(Math.min(visibleLength(header), terminalWidth)), 'dim'));

  let usedRows = 5;
  const maxRows = Math.max(1, (process.stdout.rows || 30) - 8);

  for (const group of groups) {
    if (usedRows >= maxRows) break;
    const primary = group[0];
    const title = `${primary.name} root:${primary.rootPid ?? primary.pid}`;
    const thread = primary.activityThreadId ? ` thread:${primary.activityThreadId.slice(0, 8)}` : '';
    console.log(color(`┌ ${title}${thread}`, 'blue', true));
    usedRows += 1;

    for (const proc of group) {
      if (usedRows >= maxRows) break;
      console.log(formatMonitorRow(proc, widths));
      usedRows += 1;
    }
  }

  console.log(color('─'.repeat(Math.min(width, 140)), 'dim'));
  console.log(color('Ctrl+C exit  |  --once sample once  |  -i <seconds> refresh interval  |  -k <words> filter', 'dim'));
}

function computeMonitorWidths(total: number): MonitorWidths {
  const fixed = 2 + 8 + 8 + 18 + 11 + 10 + 8 + 8;
  return {
    gutter: 2,
    pid: 8,
    root: 8,
    tool: 18,
    state: 11,
    age: 10,
    cpu: 8,
    mem: 8,
    command: Math.max(24, total - fixed),
  };
}

function pad(value: string, width: number): string {
  const truncated = truncateVisible(value, width - 1);
  return `${truncated}${' '.repeat(Math.max(0, width - visibleLength(truncated)))}`;
}

function truncateVisible(value: string, width: number): string {
  if (visibleLength(value) <= width) return value;
  if (width <= 1) return stripAnsi(value).slice(0, width);
  return `${stripAnsi(value).slice(0, Math.max(0, width - 3))}...`;
}

function formatPercent(value: number | undefined): string {
  return value == null ? '-' : `${value.toFixed(1)}%`;
}

function formatMonitorRow(process: HarnessProcess, widths: MonitorWidths): string {
  const action = formatActivity(process);
  return (
    color('│ ', 'dim') +
    pad(String(process.pid), widths.pid) +
    pad(String(process.rootPid ?? process.pid), widths.root) +
    pad(process.name, widths.tool) +
    color(pad(process.state, widths.state), stateColor(process.state), process.state !== 'unknown') +
    pad(formatAge(process.elapsedSeconds), widths.age) +
    color(pad(formatPercent(process.cpuPercent), widths.cpu), percentColor(process.cpuPercent)) +
    color(pad(formatPercent(process.memoryPercent), widths.mem), percentColor(process.memoryPercent)) +
    color(truncateVisible(action, widths.command), process.currentAction ? 'white' : 'dim')
  );
}

interface MonitorWidths {
  gutter: number;
  pid: number;
  root: number;
  tool: number;
  state: number;
  age: number;
  cpu: number;
  mem: number;
  command: number;
}

function groupByRoot(processes: HarnessProcess[]): HarnessProcess[][] {
  const byRoot = new Map<number, HarnessProcess[]>();
  for (const process of processes) {
    const root = process.rootPid ?? process.pid;
    const group = byRoot.get(root) ?? [];
    group.push(process);
    byRoot.set(root, group);
  }

  return [...byRoot.values()].sort((a, b) => {
    const aCpu = a.reduce((sum, process) => sum + (process.cpuPercent ?? 0), 0);
    const bCpu = b.reduce((sum, process) => sum + (process.cpuPercent ?? 0), 0);
    return bCpu - aCpu;
  });
}

function summarizeProcesses(processes: HarnessProcess[]): Record<'running' | 'waiting' | 'failed', number> {
  return {
    running: processes.filter((process) => process.state === 'running').length,
    waiting: processes.filter((process) => process.state === 'waiting').length,
    failed: processes.filter((process) => process.state === 'failed').length,
  };
}

function statusBadge(state: 'running' | 'waiting' | 'failed', count: number): string {
  if (count === 0) return '';
  const theme = state === 'running' ? 'green' : state === 'waiting' ? 'yellow' : 'red';
  return badge(`${state} ${count}`, theme);
}

function badge(text: string, theme: ColorName): string {
  return `${color('[', 'dim')}${color(text, theme, true)}${color(']', 'dim')}`;
}

function stateColor(state: string): ColorName {
  if (state === 'running') return 'green';
  if (state === 'waiting') return 'yellow';
  if (state === 'failed') return 'red';
  if (state === 'idle') return 'blue';
  return 'dim';
}

function percentColor(value: number | undefined): ColorName {
  if (value == null) return 'dim';
  if (value >= 50) return 'red';
  if (value >= 15) return 'yellow';
  return 'green';
}

function formatActivity(process: HarnessProcess): string {
  const action = process.currentAction ?? process.command;
  const parts: string[] = [];

  if (process.activityAt) parts.push(formatActivityTime(process.activityAt));
  if (process.activityThreadId) parts.push(process.activityThreadId.slice(0, 8));

  return parts.length ? `${parts.join(' ')}  ${action}` : action;
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatClock(date);
}

function formatAge(seconds: number | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '-';
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return `${hours}h${restMinutes}m`;

  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

function formatClock(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

type ColorName = 'blue' | 'cyan' | 'dim' | 'green' | 'magenta' | 'red' | 'white' | 'yellow';

const ANSI: Record<ColorName, string> = {
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  yellow: '\x1b[33m',
};

function color(value: string, name: ColorName, bold = false): string {
  if (!process.stdout.isTTY) return value;
  const weight = bold ? '\x1b[1m' : '';
  return `${weight}${ANSI[name]}${value}\x1b[0m`;
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}
