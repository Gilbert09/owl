import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostHogCodeClient } from '../services/posthogCode/client.js';

/**
 * `updateTask` is what makes a SECOND run on an existing PostHog task do new
 * work. The `run` endpoint carries no prompt — PostHog reads the task's
 * current `description` when it starts the run — so without this call a reused
 * task would repeat the prompt it was created with, which for a "get this PR
 * mergeable" run means acting on failures that have since changed.
 */
function stubFetchOk() {
  const stub = vi.fn(async () => new Response(JSON.stringify({ id: 'task-1' }), { status: 200 }));
  vi.stubGlobal('fetch', stub);
  return stub;
}

function lastCall(stub: ReturnType<typeof stubFetchOk>): { url: string; init: RequestInit } {
  const call = stub.mock.calls.at(-1)!;
  return { url: String(call[0]), init: call[1] as RequestInit };
}

describe('PostHogCodeClient.updateTask', () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () => new PostHogCodeClient('key', 'proj', 'https://us.posthog.com');

  it('PATCHes the task, which is what carries the new prompt', async () => {
    const stub = stubFetchOk();

    await client().updateTask('task-1', { title: 'Get #42 mergeable', description: 'new prompt' });

    const { url, init } = lastCall(stub);
    expect(init.method).toBe('PATCH');
    expect(url).toContain('/tasks/task-1/');
    expect(JSON.parse(init.body as string)).toEqual({
      title: 'Get #42 mergeable',
      description: 'new prompt',
    });
  });

  it('omits a field it was not given rather than blanking it', async () => {
    const stub = stubFetchOk();

    await client().updateTask('task-1', { description: 'only the prompt' });

    expect(JSON.parse(lastCall(stub).init.body as string)).toEqual({
      description: 'only the prompt',
    });
  });

  it('surfaces a 404 with its status, so a vanished task can be told apart', async () => {
    // The executor catches exactly this to fall back to creating a fresh
    // remote task, instead of failing a dispatch on a stale id it only kept
    // as an optimisation.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    );

    await expect(client().updateTask('gone', { description: 'x' })).rejects.toMatchObject({
      status: 404,
    });
  });
});
