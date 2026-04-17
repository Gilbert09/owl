import type { ApiResponse } from '@fastowl/shared';
import { getAuthToken } from './config.js';

const DEFAULT_BASE = process.env.FASTOWL_API_URL || 'http://localhost:4747';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thin fetch wrapper that unwraps ApiResponse<T> and throws on error. */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  base: string = DEFAULT_BASE
): Promise<T> {
  const url = `${base}/api/v1${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    throw new ApiError(
      'Not authenticated. Run `fastowl token set` (paste the token from the desktop app → Settings → Copy CLI token) or set FASTOWL_AUTH_TOKEN.',
      401
    );
  }

  let payload: ApiResponse<T>;
  try {
    payload = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(`Invalid JSON from ${url}`, res.status);
  }

  if (!payload.success) {
    throw new ApiError(payload.error || `${method} ${path} failed`, res.status);
  }
  return payload.data as T;
}

export function baseUrl(): string {
  return DEFAULT_BASE;
}
