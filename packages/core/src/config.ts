import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AiHudConfig {
  cursorApiKey?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.ai-hud');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): AiHudConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const obj = JSON.parse(raw) as AiHudConfig;
    return obj ?? {};
  } catch {
    return {};
  }
}

export function saveConfig(config: AiHudConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function maskApiKey(key: string | undefined): string {
  if (!key || key.length < 8) return '';
  return key.slice(0, 4) + '...' + key.slice(-4);
}
