import { config } from '@/config';

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const normalizeAbsoluteUrl = (value?: string | null): string | null => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  try {
    return trimTrailingSlash(new URL(trimmed).toString());
  } catch {
    return null;
  }
};

const extractOrigin = (value?: string | null): string | null => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};

const buildOrigin = (host: string, port: number, protocol: 'http' | 'https' = 'http'): string => {
  const normalizedHost =
    host === '0.0.0.0' || host === '::' || host === '::1' ? 'localhost' : host;
  const defaultPort = protocol === 'https' ? 443 : 80;

  return `${protocol}://${normalizedHost}${port === defaultPort ? '' : `:${port}`}`;
};

export const getRequestOrigin = (headers?: Record<string, unknown>): string | null => {
  const origin = extractOrigin(String(headers?.origin || ''));
  if (origin) return origin;
  return extractOrigin(String(headers?.referer || ''));
};

export const getPublicFrontendUrl = (): string => {
  return (
    normalizeAbsoluteUrl(process.env.PUBLIC_BASE_URL) ||
    buildOrigin(config.Frontend.host, config.Frontend.port)
  );
};

export const getPublicApiBaseUrl = (): string => {
  const explicitApiUrl = normalizeAbsoluteUrl(process.env.PUBLIC_API_BASE_URL);
  if (explicitApiUrl) return explicitApiUrl;

  const publicBaseUrl = normalizeAbsoluteUrl(process.env.PUBLIC_BASE_URL);
  if (publicBaseUrl) return `${publicBaseUrl}/dev-api`;

  return buildOrigin(config.Backend.host, config.Backend.port);
};
