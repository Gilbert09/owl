// The visual-review client — run selection and finalize outcome mapping.
//
// Both halves guard something expensive. Picking the wrong run finalizes diffs
// that are not the ones holding the PR; mapping the wrong outcome either burns
// a retry budget on a transient 429 or, worse, treats a hard refusal as
// something to keep trying.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCredentials = vi.fn();
vi.mock('../services/posthogCode/credentials.js', () => ({
  getPostHogCodeCredentials: (...args: unknown[]) => getCredentials(...args),
}));
vi.mock('../services/debugBus.js', () => ({
  debugBus: { recordHttp: vi.fn(), recordEvent: vi.fn() },
}));

const { finalizeRun, gatingRunForPr } = await import('../services/visualReview.js');

const HOST = 'https://us.posthog.com';
const HEAD = 'sha-head';

function creds(over: Record<string, unknown> = {}) {
  return {
    projectId: '2',
    host: HOST,
    authMethod: 'personal_api_key',
    reauthRequired: false,
    getToken: async () => 'tok',
    ...over,
  };
}

/** One run as the API serialises it. */
function run(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    pr_number: 83850,
    commit_sha: HEAD,
    status: 'completed',
    approved: false,
    is_stale: false,
    summary: { changed: 4, new: 0 },
    _posthogUrl: `${HOST}/project/2/visual_review/runs/run-1`,
    ...over,
  };
}

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: new Headers(),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }))
  );
}

beforeEach(() => {
  getCredentials.mockResolvedValue(creds());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('gatingRunForPr', () => {
  it('returns the run that is actually holding the PR', async () => {
    mockFetch(200, { results: [run()] });
    const got = await gatingRunForPr('ws1', 83850, HEAD);
    expect(got).toMatchObject({ id: 'run-1', changed: 4 });
  });

  it.each([
    ['stale (superseded by a newer run)', { is_stale: true }],
    ['still uploading', { status: 'pending' }],
    ['already approved', { approved: true }],
    ['nothing changed', { summary: { changed: 0, new: 0 } }],
    // Finalizing a run for a commit that is no longer the head 409s
    // sha_mismatch, and would approve diffs the head may not contain.
    ['for a commit that is no longer the head', { commit_sha: 'sha-old' }],
  ])('ignores a run that is %s', async (_label, over) => {
    mockFetch(200, { results: [run(over)] });
    expect(await gatingRunForPr('ws1', 83850, HEAD)).toBeNull();
  });

  it('is null, not a throw, when the workspace has no PostHog credentials', async () => {
    getCredentials.mockResolvedValue(null);
    expect(await gatingRunForPr('ws1', 83850, HEAD)).toBeNull();
  });

  it('does not use a grant that needs reconnecting', async () => {
    getCredentials.mockResolvedValue(creds({ reauthRequired: true }));
    expect(await gatingRunForPr('ws1', 83850, HEAD)).toBeNull();
  });
});

describe('finalizeRun', () => {
  it('reports the committed baseline on success', async () => {
    mockFetch(200, { metadata: { baseline_commit_sha: 'abc123' } });
    expect(await finalizeRun('ws1', 'run-1')).toEqual({
      kind: 'finalized',
      baselineCommitSha: 'abc123',
    });
  });

  it('succeeds with no commit when nothing needed committing', async () => {
    mockFetch(200, {});
    expect(await finalizeRun('ws1', 'run-1')).toEqual({
      kind: 'finalized',
      baselineCommitSha: null,
    });
  });

  // A 409 is never an error: both shapes mean the PR moved under us, which is
  // ordinary on an active branch. Treating them as failures would spend the
  // budget on a PR that just needs re-resolving.
  it.each([
    ['stale_run', 'stale'],
    ['sha_mismatch', 'sha_mismatch'],
  ] as const)('maps a 409 %s to %s', async (code, kind) => {
    mockFetch(409, { code, detail: 'moved on' });
    expect((await finalizeRun('ws1', 'run-1')).kind).toBe(kind);
  });

  it.each([[429], [500], [502], [503]])('retries rather than failing on %i', async (status) => {
    mockFetch(status, { detail: 'later' });
    expect((await finalizeRun('ws1', 'run-1')).kind).toBe('retry');
  });

  it('names the missing scope on a 403 — the answer is configuration, not retry', async () => {
    mockFetch(403, { detail: 'forbidden' });
    const out = await finalizeRun('ws1', 'run-1');
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('visual_review:write');
  });

  it('is terminal on a 409 the run itself cannot resolve', async () => {
    mockFetch(409, { code: 'not_fully_resolved', detail: '2 snapshots quarantined' });
    const out = await finalizeRun('ws1', 'run-1');
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('2 snapshots quarantined');
  });

  it('retries a network failure rather than declaring the run unfixable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      })
    );
    expect((await finalizeRun('ws1', 'run-1')).kind).toBe('retry');
  });

  it('refuses without credentials instead of throwing into the evaluation', async () => {
    getCredentials.mockResolvedValue(null);
    expect((await finalizeRun('ws1', 'run-1')).kind).toBe('error');
  });

  it('sends approve_all and commits to GitHub', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: '',
      headers: new Headers(),
      text: async () => '{}',
    }));
    vi.stubGlobal('fetch', spy);
    await finalizeRun('ws1', 'run-1');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HOST}/api/projects/2/visual_review/runs/run-1/finalize/`);
    expect(JSON.parse(init.body as string)).toMatchObject({
      approve_all: true,
      commit_to_github: true,
    });
  });

  it('honours a project id override over the Code integration default', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: '',
      headers: new Headers(),
      text: async () => '{}',
    }));
    vi.stubGlobal('fetch', spy);
    await finalizeRun('ws1', 'run-1', '999');
    expect((spy.mock.calls[0] as unknown as [string])[0]).toContain('/api/projects/999/');
  });
});
