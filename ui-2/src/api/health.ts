const rawBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || '/dev-api';
const BASE_URL = rawBaseUrl.replace(/\/+$/, '');

export interface HealthStatus {
  status: 'ok' | 'degraded';
  db: boolean;
  llm: boolean;
  timestamp: string;
}

export async function checkSystemHealth(): Promise<HealthStatus> {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}
