import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session, SessionStore } from '@ai-hud/core';
import type { SessionAdapter } from '@ai-hud/core';

/** Cursor composer 元数据（来自 state.vscdb ItemTable key=composer.composerData） */
interface ComposerData {
  allComposers?: Array<{
    composerId?: string;
    name?: string;
    createdAt?: number;
    lastUpdatedAt?: number;
    contextUsagePercent?: number;
  }>;
}

const CURSOR_BASE = join(
  homedir(),
  'Library',
  'Application Support',
  'Cursor'
);
const WORKSPACE_STORAGE = join(
  CURSOR_BASE,
  'User',
  'workspaceStorage'
);

function getProjectPath(workspaceDir: string): string | undefined {
  try {
    const wp = join(workspaceDir, 'workspace.json');
    if (!existsSync(wp)) return undefined;
    const raw = readFileSync(wp, 'utf8');
    const obj = JSON.parse(raw) as { folder?: string };
    const folder = obj?.folder;
    if (typeof folder !== 'string' || !folder.startsWith('file://')) {
      return undefined;
    }
    return decodeURIComponent(folder.replace(/^file:\/\//, ''));
  } catch {
    return undefined;
  }
}

function queryComposerData(dbPath: string): ComposerData | null {
  const result = spawnSync(
    'sqlite3',
    [dbPath, "SELECT value FROM ItemTable WHERE key = 'composer.composerData'"],
    { encoding: 'utf8', windowsHide: true }
  );
  if (result.status !== 0 || !result.stdout?.trim()) return null;
  try {
    return JSON.parse(result.stdout) as ComposerData;
  } catch {
    return null;
  }
}

export class CursorAdapter implements SessionAdapter {
  readonly name = 'cursor';

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    return existsSync(CURSOR_BASE);
  }

  async collect(store: SessionStore): Promise<Session[]> {
    if (!existsSync(WORKSPACE_STORAGE)) return [];
    const sessions: Session[] = [];

    let subdirs: string[];
    try {
      subdirs = readdirSync(WORKSPACE_STORAGE, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }

    for (const hash of subdirs) {
      const dir = join(WORKSPACE_STORAGE, hash);
      const statePath = join(dir, 'state.vscdb');
      if (!existsSync(statePath)) continue;

      try {
        const data = queryComposerData(statePath);
        if (!data?.allComposers?.length) continue;

        const projectPath = getProjectPath(dir);

        for (const c of data.allComposers) {
          const id = c.composerId;
          if (!id) continue;

          const existing = await store.getById(id);
          if (existing != null) continue;

          const created = c.createdAt ?? 0;
          const updated = c.lastUpdatedAt ?? created;
          sessions.push({
            id,
            source: 'cursor',
            startedAt: new Date(created).toISOString(),
            endedAt: new Date(updated).toISOString(),
            ...(projectPath && { projectPath }),
            ...(c.name && { prompt: c.name.length > 500 ? c.name.slice(0, 500) + '...' : c.name }),
            // Cursor composer.composerData 未提供 token 字段，contextUsage 留空
          });
        }
      } catch (err) {
        console.error(`[CursorAdapter] read ${statePath} failed:`, err);
      }
    }

    return sessions;
  }
}
