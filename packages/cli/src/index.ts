#!/usr/bin/env node
import { Command } from 'commander';
import { Collector, SqliteStore, type Session } from '@ai-hud/core';
import { OpenCodeAdapter, runWithCapture } from '@ai-hud/adapters';
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
      const collector = new Collector(store, [new OpenCodeAdapter()]);
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
    await startServer(port);

    const store = new SqliteStore();
    const collector = new Collector(store, [new OpenCodeAdapter()]);
    await collector.run();
    setInterval(() => collector.run(), 60_000);
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

program.parse();

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
