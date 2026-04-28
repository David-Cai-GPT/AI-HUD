export type HarnessState = 'running' | 'waiting' | 'idle' | 'failed' | 'unknown';

export interface HarnessProcess {
  id: string;
  pid: number;
  parentPid: number;
  name: string;
  kind: string;
  command: string;
  cwd?: string;
  rootPid?: number;
  state: HarnessState;
  startedAt?: string;
  elapsedSeconds?: number;
  cpuPercent?: number;
  memoryPercent?: number;
  currentAction?: string;
  activityAt?: string;
  activityThreadId?: string;
}

export interface HarnessDiscoveryOptions {
  includeAll?: boolean;
  keywords?: string[];
}

export interface HarnessDiscoverer {
  discover(options?: HarnessDiscoveryOptions): Promise<HarnessProcess[]>;
}
