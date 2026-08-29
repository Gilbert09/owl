import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostHogCodeClient } from '../services/posthogCode/client.js';

/**
 * Stopping a run goes through PostHog's dedicated cancel action, which
 * interrupts the agent and tears down the sandbox. A PATCH to
 * `status: cancelled` only flips the row, so the run keeps working.
 */
function stubFetch(status: number, body: unknown) {
  const stub = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', stub);
  return stub;
}

describe('PostHogCodeClient.cancelRun', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['accepted', 202],
    ['already finished', 200],
  ])('posts to the run cancel action and returns the run when %s', async (_label, status) => {
    const stub = stubFetch(status, { id: 'run-1', status: 'cancelled' });
    const client = new PostHogCodeClient('key', 'proj', 'https://us.posthog.com');

    const run = await client.cancelRun('task-1', 'run-1');

    expect(run).toMatchObject({ id: 'run-1', status: 'cancelled' });
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://us.posthog.com/api/projects/proj/tasks/task-1/runs/run-1/cancel/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'Stopped from Talyn' });
  });

  it('throws with the status when the workflow cannot be reached', async () => {
    stubFetch(503, { error: "Could not reach the run's workflow; try again" });
    const client = new PostHogCodeClient('key', 'proj', 'https://us.posthog.com');

    await expect(client.cancelRun('task-1', 'run-1')).rejects.toMatchObject({
      status: 503,
    });
  });
});
