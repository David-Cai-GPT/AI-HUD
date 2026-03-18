import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OpenCodeConfig {
  mcp?: Record<string, { enabled?: boolean }>;
}

function loadJson(path: string): OpenCodeConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(cleaned) as OpenCodeConfig;
  } catch {
    return null;
  }
}

function findProjectConfig(cwd: string): string | null {
  let dir = cwd;
  while (dir) {
    const p = join(dir, 'opencode.json');
    if (existsSync(p)) return p;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadMergedConfig(cwd: string): OpenCodeConfig {
  const globalPath = join(homedir(), '.config', 'opencode', 'opencode.json');
  const projectPath = findProjectConfig(cwd);
  const global = loadJson(globalPath) ?? {};
  const project = projectPath ? loadJson(projectPath) ?? {} : {};
  return {
    mcp: { ...global.mcp, ...project.mcp },
  };
}

export function getEnabledMcpServers(config: OpenCodeConfig): string[] {
  const mcp = config.mcp ?? {};
  return Object.entries(mcp)
    .filter(([, v]) => v?.enabled !== false)
    .map(([k]) => k);
}
