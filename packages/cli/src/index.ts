#!/usr/bin/env node
import { Command } from 'commander';
import { SqliteStore } from '@ai-hud/core';
import { runWithCapture } from '@ai-hud/adapters';

const program = new Command();

program
  .name('ai-hud')
  .description('AI-HUD: monitor and record AI coding tool sessions')
  .version('0.0.1');

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
