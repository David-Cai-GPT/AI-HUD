export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreate?: number;
  systemTokens?: number;
  userTokens?: number;
  assistantTokens?: number;
}

export interface ToolUsage {
  name: string;
  count: number;
  accepted?: number;
  rejected?: number;
}

export interface CostInfo {
  currency: string;
  amount: number;
}

export interface TaskItem {
  id?: string;
  content: string;
  status?: 'pending' | 'in_progress' | 'completed';
}

export interface Session {
  id: string;
  source: string;
  startedAt: string;
  endedAt?: string;
  projectPath?: string;
  model?: string;
  prompt?: string;
  contextUsage?: ContextUsage;
  /** Cursor 专有：上下文占用百分比（无 token 时用此近似展示） */
  contextUsagePercent?: number;
  tools?: ToolUsage[];
  agents?: string[];
  skills?: string[];
  mcp?: string[];
  tasks?: TaskItem[];
  cost?: CostInfo;
}
