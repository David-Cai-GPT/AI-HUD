/**
 * Cursor Analytics API 客户端
 * 需 Enterprise 团队 API Key，见 https://cursor.com/docs/account/teams/analytics-api
 */

const CURSOR_API_BASE = 'https://api.cursor.com';

export interface CursorModelsResponse {
  data?: Array<{
    date?: string;
    model_breakdown?: Record<string, { messages?: number; users?: number }>;
  }>;
  params?: { startDate?: string; endDate?: string };
}

export interface CursorApiError {
  error?: string;
  message?: string;
}

export async function fetchCursorModels(
  apiKey: string,
  startDate = '7d',
  endDate = 'today'
): Promise<CursorModelsResponse | CursorApiError> {
  const url = `${CURSOR_API_BASE}/analytics/team/models?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
  const auth = Buffer.from(`${apiKey}:`, 'utf8').toString('base64');

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  });

  const data = (await res.json()) as CursorModelsResponse | CursorApiError;

  if (!res.ok) {
    return {
      error: (data as CursorApiError).error ?? 'Unknown',
      message: (data as CursorApiError).message ?? `HTTP ${res.status}`,
    };
  }

  return data as CursorModelsResponse;
}
