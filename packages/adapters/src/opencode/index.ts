import { spawnSync } from 'node:child_process';
import type { Session } from '@ai-hud/core';
import type { SessionAdapter } from '../types.js';

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
