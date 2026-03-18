import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SKILL_EXT = ['.md', '.txt'];

function scanDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const names = readdirSync(dir);
    return names
      .filter((n) => SKILL_EXT.some((e) => n.endsWith(e)))
      .map((n) => n.replace(/\.(md|txt)$/i, ''));
  } catch {
    return [];
  }
}

export function scanSkills(cwd: string): string[] {
  const projectDir = join(cwd, '.opencode', 'skills');
  const globalDir = join(homedir(), '.config', 'opencode', 'skills');
  const project = scanDir(projectDir);
  const global = scanDir(globalDir);
  return [...new Set([...project, ...global])];
}
