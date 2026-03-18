export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreate?: number;
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
  tools?: ToolUsage[];
  agents?: string[];
  skills?: string[];
  mcp?: string[];
  tasks?: TaskItem[];
  cost?: CostInfo;
}
