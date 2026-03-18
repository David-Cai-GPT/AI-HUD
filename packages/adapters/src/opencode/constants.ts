export const BUILTIN_TOOLS = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'grep',
  'glob',
  'list',
  'webfetch',
  'websearch',
  'task',
]);

export function inferMcpName(toolName: string): string {
  const first = toolName.split('_')[0];
  return first && first !== toolName ? first : 'mcp';
}
