import type { ApiResponse } from '@fastowl/shared';

const DEFAULT_BASE = process.env.FASTOWL_API_URL || 'http://localhost:4747';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * MCP runs inside a child Claude process; the parent is responsible for
 * setting FASTOWL_AUTH_TOKEN on spawn. We don't fall back to the CLI's
 * on-disk token file because MCP servers aren't tied to a shell user.
 */
function getAuthToken(): string | null {
  const t = process.env.FASTOWL_AUTH_TOKEN;
  return t && t.trim() ? t.trim() : null;
}

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
      'Not authenticated. FASTOWL_AUTH_TOKEN is missing — the parent agent process must set it on spawn.',
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

export function workspaceId(): string | undefined {
  return process.env.FASTOWL_WORKSPACE_ID;
}

export function taskId(): string | undefined {
  return process.env.FASTOWL_TASK_ID;
}
