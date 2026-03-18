import { spawn, spawnSync } from 'node:child_process';
import type { Session, SessionStore } from '@ai-hud/core';
import type { ContextUsage, CostInfo, ToolUsage } from '@ai-hud/core';
import type { SessionAdapter } from '../types.js';

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

function timestampToIso(ms: number): string {
  return new Date(ms).toISOString();
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
    const proc = spawn('opencode', ['run', '--format', 'stream-json', task], {
      stdio: ['inherit', 'pipe', 'inherit'],
      cwd: cwd ?? process.cwd(),
      windowsHide: true,
    });

    let session: Partial<Session> | null = null;
    let tools: ToolUsage[] = [];
    let sessionToAppend: Session | null = null;

    const stdout = proc.stdout;
    if (!stdout) {
      proc.once('error', reject);
      proc.once('close', (code) => {
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
              };
              tools = [];
              break;
            }
            case 'tool_use': {
              const toolName = ev.part?.tool;
              if (toolName) tools = parseToolUsage(tools, toolName);
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

                sessionToAppend = {
                  id: session.id!,
                  source: session.source!,
                  startedAt: session.startedAt!,
                  endedAt: timestampToIso(ev.timestamp),
                  ...(contextUsage && { contextUsage }),
                  ...(tools.length > 0 && { tools }),
                  ...(cost && { cost }),
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
    proc.once('close', async (code) => {
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

export class OpenCodeAdapter implements SessionAdapter {
  readonly name = 'opencode';

  async isAvailable(): Promise<boolean> {
    const result = spawnSync('opencode', ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.status === 0;
  }

  async collect(): Promise<Session[]> {
    return [];
  }
}
