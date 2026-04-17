import type { ApiResponse } from '@fastowl/shared';

const DEFAULT_BASE = process.env.FASTOWL_API_URL || 'http://localhost:4747';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  base: string = DEFAULT_BASE
): Promise<T> {
  const url = `${base}/api/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
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
