import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  compareVersions,
  filterReleaseCommits,
  kindForCommitType,
  highlightsForSurface,
  nextSeenVersion,
  parseConventionalCommit,
  parseVersion,
  shouldShowWhatsNew,
  surfacesForScope,
  versionSortKey,
  type ReleaseHighlight,
  type ReleaseNoteEntry,
} from '@talyn/shared';
import { createTestDb } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  ingestTokenValid,
  latestReleaseNote,
  listReleaseNotes,
  parseHighlights,
  releaseIngestConfigured,
  upsertReleaseNote,
} from '../services/releaseNotes.js';

const highlight = (over: Partial<ReleaseHighlight> = {}): ReleaseHighlight => ({
  title: 'Watch a PR you did not write',
  description: 'Paste a pull request URL to track its checks alongside your own.',
  kind: 'feature',
  surfaces: ['desktop', 'web'],
  ...over,
});

const entry = (version: string, highlights: ReleaseHighlight[] = [highlight()]): ReleaseNoteEntry => ({
  version,
  publishedAt: '2026-08-30T03:00:00.000Z',
  highlights,
});

describe('shared/releaseNotes — versions', () => {
  it('parses X.Y.Z with or without the leading v, and rejects anything else', () => {
    expect(parseVersion('0.2.61')).toEqual({ major: 0, minor: 2, patch: 61 });
    expect(parseVersion('v0.2.61')).toEqual({ major: 0, minor: 2, patch: 61 });
    expect(parseVersion(' 1.10.0 ')).toEqual({ major: 1, minor: 10, patch: 0 });
    for (const bad of ['dev', 'web/abc1234', '0.2', '0.2.61-rc1', '', null, undefined]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });

  it('orders versions numerically, not as text', () => {
    // The whole reason sort_key exists: "0.2.9" > "0.2.10" as a string.
    expect(compareVersions('0.2.9', '0.2.10')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.999.999')).toBeGreaterThan(0);
    expect(compareVersions('0.2.61', '0.2.61')).toBe(0);
  });

  it('keeps sort keys distinct past a thousand nightly patches', () => {
    // A 10^3 stride would collide here — Talyn ships a patch every night, so
    // three years of nightlies is a real range, not a hypothetical one.
    expect(versionSortKey('0.2.999')).toBeLessThan(versionSortKey('0.2.1000'));
    expect(versionSortKey('0.2.1000')).toBeLessThan(versionSortKey('0.3.0'));
    // ...and stays an exact integer.
    expect(Number.isSafeInteger(versionSortKey('9.999.999'))).toBe(true);
  });

  it('gives an unparseable version a key below every real one', () => {
    expect(versionSortKey('dev')).toBeLessThan(versionSortKey('0.0.0'));
  });
});

describe('shared/releaseNotes — commit filtering', () => {
  it('parses the conventional-commit shapes this repo actually produces', () => {
    // Squash-merged through the GitHub UI: carries a trailing PR number.
    expect(parseConventionalCommit('feat(desktop): adopt Liquid Glass icon for macOS 26 (#56)')).toEqual(
      {
        type: 'feat',
        scope: 'desktop',
        subject: 'adopt Liquid Glass icon for macOS 26',
        pr: 56,
        raw: 'feat(desktop): adopt Liquid Glass icon for macOS 26 (#56)',
      }
    );
    // Direct push: no PR number, which is the common case here.
    expect(parseConventionalCommit('fix(settings): drop a duplicate toast import')).toMatchObject({
      type: 'fix',
      scope: 'settings',
      subject: 'drop a duplicate toast import',
      pr: null,
    });
    // No scope at all.
    expect(parseConventionalCommit('perf: batch the freshness refetch')).toMatchObject({
      type: 'perf',
      scope: null,
      subject: 'batch the freshness refetch',
    });
    // Breaking-change marker.
    expect(parseConventionalCommit('feat(api)!: drop the v0 routes')).toMatchObject({
      type: 'feat',
      scope: 'api',
      subject: 'drop the v0 routes',
    });
  });

  it('returns null for a merge commit and for prose that is not conventional', () => {
    expect(parseConventionalCommit('Merge pull request #85 from Gilbert09/tom/x')).toBeNull();
    expect(parseConventionalCommit('compare watch labels case-insensitively')).toBeNull();
    expect(parseConventionalCommit('')).toBeNull();
  });

  it('reads only the subject line of a multi-line message', () => {
    expect(
      parseConventionalCommit('feat(web): add a thing\n\nA long body that mentions fix(x): nope')
    ).toMatchObject({ type: 'feat', scope: 'web', subject: 'add a thing' });
  });

  it('keeps feat/fix/perf and drops everything else', () => {
    const kept = filterReleaseCommits([
      'feat(pr-list): watch an arbitrary PR',
      'fix(github): stop dropping check runs',
      'perf(prCache): batch the freshness refetch',
      'docs: update SESSIONS',
      'chore(deps): bump electron',
      'refactor(tasks): extract the poller',
      'test(mergeQueue): cover the stack walk',
      'style: reformat',
      'Merge pull request #85 from Gilbert09/tom/x',
    ]);
    expect(kept.map((c) => c.type)).toEqual(['feat', 'fix', 'perf']);
  });

  it('drops scopes a Talyn user cannot see from inside the app', () => {
    const kept = filterReleaseCommits([
      'feat(admin): add a cross-tenant task list',
      'fix(fleet): stop dialling a stale host',
      'fix(ci): pin the runner image',
      'feat(marketing): new pricing page',
      'feat(desktop): apply a staged update once the machine goes idle',
    ]);
    expect(kept.map((c) => c.scope)).toEqual(['desktop']);
  });

  it('maps a commit scope to the clients it can possibly affect', () => {
    expect(surfacesForScope('desktop')).toEqual(['desktop']);
    expect(surfacesForScope('web')).toEqual(['web']);
    // A backend or shared change reaches both, and so does a bare commit.
    expect(surfacesForScope('merge-queue')).toEqual(['desktop', 'web']);
    expect(surfacesForScope(null)).toEqual(['desktop', 'web']);
  });

  it('maps a commit type to a highlight kind', () => {
    expect(kindForCommitType('feat')).toBe('feature');
    expect(kindForCommitType('fix')).toBe('fix');
    expect(kindForCommitType('perf')).toBe('improvement');
  });
});

describe('shared/releaseNotes — shouldShowWhatsNew', () => {
  const base = {
    currentVersion: '0.2.63',
    surface: 'desktop' as const,
  };

  it('shows nothing on a first run, however much is available', () => {
    expect(
      shouldShowWhatsNew({ ...base, lastSeenVersion: null, entries: [entry('0.2.62')] })
    ).toEqual([]);
    // An unparseable stored value is treated the same way: the caller
    // re-baselines rather than blasting a new user with the whole changelog.
    expect(
      shouldShowWhatsNew({ ...base, lastSeenVersion: 'dev', entries: [entry('0.2.62')] })
    ).toEqual([]);
  });

  it('returns everything newer than the last-seen version, newest first', () => {
    const shown = shouldShowWhatsNew({
      ...base,
      lastSeenVersion: '0.2.60',
      entries: [entry('0.2.61'), entry('0.2.63'), entry('0.2.62'), entry('0.2.60')],
    });
    expect(shown.map((e) => e.version)).toEqual(['0.2.63', '0.2.62', '0.2.61']);
  });

  it('never shows a release the running build does not have yet', () => {
    // The backend knows about tonight's release the moment CI posts it; the
    // desktop user is still on last night's build.
    const shown = shouldShowWhatsNew({
      ...base,
      currentVersion: '0.2.62',
      lastSeenVersion: '0.2.60',
      entries: [entry('0.2.61'), entry('0.2.62'), entry('0.2.63')],
    });
    expect(shown.map((e) => e.version)).toEqual(['0.2.62', '0.2.61']);
  });

  it('applies no ceiling when the client has no orderable version (the web fork)', () => {
    const shown = shouldShowWhatsNew({
      lastSeenVersion: '0.2.60',
      currentVersion: null,
      surface: 'web',
      entries: [entry('0.2.61'), entry('0.2.63')],
    });
    expect(shown.map((e) => e.version)).toEqual(['0.2.63', '0.2.61']);
  });

  it('drops highlights for the other client, and releases thereby left empty', () => {
    const shown = shouldShowWhatsNew({
      ...base,
      lastSeenVersion: '0.2.60',
      entries: [
        entry('0.2.62', [highlight({ surfaces: ['web'] })]),
        entry('0.2.61', [
          highlight({ title: 'Desktop only', surfaces: ['desktop'] }),
          highlight({ title: 'Web only', surfaces: ['web'] }),
        ]),
      ],
    });
    expect(shown.map((e) => e.version)).toEqual(['0.2.61']);
    expect(shown[0].highlights.map((h) => h.title)).toEqual(['Desktop only']);
  });

  it('shows nothing for a release that carried no highlights at all', () => {
    expect(
      shouldShowWhatsNew({ ...base, lastSeenVersion: '0.2.60', entries: [entry('0.2.61', [])] })
    ).toEqual([]);
  });
});

describe('shared/releaseNotes — highlightsForSurface', () => {
  // The Settings → About button reads the whole changelog rather than a span,
  // so it does not go through shouldShowWhatsNew. Both paths share this filter
  // so a desktop user cannot see a web-only line just because they arrived
  // from a different button.
  it('keeps only this client\'s highlights and drops releases left empty', () => {
    const filtered = highlightsForSurface(
      [
        entry('0.2.62', [highlight({ title: 'Web only', surfaces: ['web'] })]),
        entry('0.2.61', [
          highlight({ title: 'Both' }),
          highlight({ title: 'Desktop only', surfaces: ['desktop'] }),
          highlight({ title: 'Web only', surfaces: ['web'] }),
        ]),
      ],
      'desktop'
    );
    expect(filtered.map((e) => e.version)).toEqual(['0.2.61']);
    expect(filtered[0].highlights.map((h) => h.title)).toEqual(['Both', 'Desktop only']);
  });

  it('leaves the input untouched', () => {
    const input = [entry('0.2.61', [highlight({ surfaces: ['web'] })])];
    highlightsForSurface(input, 'desktop');
    expect(input[0].highlights).toHaveLength(1);
  });
});

describe('shared/releaseNotes — nextSeenVersion', () => {
  it('records a release whose highlights were all for the other client', () => {
    // Otherwise this release is re-fetched and re-evaluated on every launch,
    // forever, and never shown.
    const input = {
      lastSeenVersion: '0.2.60',
      currentVersion: '0.2.63',
      surface: 'desktop' as const,
      entries: [entry('0.2.61', [highlight({ surfaces: ['web'] })])],
    };
    expect(shouldShowWhatsNew(input)).toEqual([]);
    expect(nextSeenVersion(input)).toBe('0.2.61');
  });

  it('never records a release the running build does not have', () => {
    // Recording 0.2.63 here would swallow its notes: the user would update to
    // it and never be told what changed.
    expect(
      nextSeenVersion({
        lastSeenVersion: '0.2.60',
        currentVersion: '0.2.62',
        surface: 'desktop',
        entries: [entry('0.2.62'), entry('0.2.63')],
      })
    ).toBe('0.2.62');
  });

  it('leaves the stored version alone when nothing is in range', () => {
    expect(
      nextSeenVersion({
        lastSeenVersion: '0.2.62',
        currentVersion: '0.2.62',
        surface: 'desktop',
        entries: [entry('0.2.63')],
      })
    ).toBe('0.2.62');
    expect(
      nextSeenVersion({
        lastSeenVersion: null,
        currentVersion: '0.2.62',
        surface: 'desktop',
        entries: [entry('0.2.61')],
      })
    ).toBeNull();
  });
});

describe('services/releaseNotes — ingest auth', () => {
  afterEach(() => {
    delete process.env.TALYN_RELEASE_INGEST_SECRET;
  });

  it('refuses everything when the secret is unset', () => {
    expect(releaseIngestConfigured()).toBe(false);
    expect(ingestTokenValid('anything')).toBe(false);
    expect(ingestTokenValid(undefined)).toBe(false);
    expect(ingestTokenValid('')).toBe(false);
  });

  it('accepts only an exact match', () => {
    process.env.TALYN_RELEASE_INGEST_SECRET = 'correct-horse-battery-staple';
    expect(releaseIngestConfigured()).toBe(true);
    expect(ingestTokenValid('correct-horse-battery-staple')).toBe(true);
    expect(ingestTokenValid('correct-horse-battery-stapl')).toBe(false); // shorter
    expect(ingestTokenValid('correct-horse-battery-staplex')).toBe(false); // longer
    expect(ingestTokenValid('Correct-Horse-Battery-Staple')).toBe(false); // case
    expect(ingestTokenValid(undefined)).toBe(false);
  });
});

describe('services/releaseNotes — parseHighlights', () => {
  it('accepts a well-formed list and trims it', () => {
    const res = parseHighlights([
      { title: '  Watch a PR  ', description: '  Track its checks.  ', kind: 'feature', surfaces: ['web', 'web'] },
    ]);
    expect(res).toEqual({
      ok: true,
      value: [
        {
          title: 'Watch a PR',
          description: 'Track its checks.',
          kind: 'feature',
          // Deduped — a doubled surface would render the line twice.
          surfaces: ['web'],
        },
      ],
    });
  });

  it('accepts an empty list — a quiet nightly is a normal outcome', () => {
    expect(parseHighlights([])).toEqual({ ok: true, value: [] });
  });

  it('rejects the whole payload on one malformed entry', () => {
    const bad = [
      [{ title: '', description: 'x', kind: 'fix', surfaces: ['web'] }],
      [{ title: 'x', description: '', kind: 'fix', surfaces: ['web'] }],
      [{ title: 'x', description: 'y', kind: 'refactor', surfaces: ['web'] }],
      [{ title: 'x', description: 'y', kind: 'fix', surfaces: [] }],
      [{ title: 'x', description: 'y', kind: 'fix', surfaces: ['mobile'] }],
      [{ title: 'x', description: 'y', kind: 'fix' }],
      ['not an object'],
      'not an array',
    ];
    for (const payload of bad) {
      expect(parseHighlights(payload).ok).toBe(false);
    }
    // One good entry does not rescue a bad sibling.
    expect(
      parseHighlights([highlight(), { title: 'x', description: 'y', kind: 'nope', surfaces: ['web'] }]).ok
    ).toBe(false);
  });
});

describe('services/releaseNotes — storage', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ cleanup } = await createTestDb() as { db: Database; cleanup: () => Promise<void> });
  });

  afterEach(async () => {
    await cleanup();
  });

  const publish = (version: string, day: number, highlights: ReleaseHighlight[] = [highlight()]) =>
    upsertReleaseNote({
      version,
      publishedAt: new Date(Date.UTC(2026, 7, day, 3, 0, 0)),
      highlights,
    });

  it('stores and reads a release back', async () => {
    await publish('0.2.61', 30);
    const [row] = await listReleaseNotes();
    expect(row).toEqual({
      version: '0.2.61',
      publishedAt: '2026-08-30T03:00:00.000Z',
      highlights: [highlight()],
    });
  });

  it('is idempotent on version, and a re-run replaces the highlights', async () => {
    await publish('0.2.61', 30, [highlight({ title: 'First attempt' })]);
    await publish('0.2.61', 30, [highlight({ title: 'Regenerated' })]);
    const rows = await listReleaseNotes();
    expect(rows).toHaveLength(1);
    expect(rows[0].highlights[0].title).toBe('Regenerated');
  });

  it('orders newest first, numerically', async () => {
    await publish('0.2.9', 20);
    await publish('0.2.10', 21);
    await publish('0.3.0', 22);
    expect((await listReleaseNotes()).map((e) => e.version)).toEqual(['0.3.0', '0.2.10', '0.2.9']);
  });

  it('filters to releases strictly newer than `since`', async () => {
    await publish('0.2.9', 20);
    await publish('0.2.10', 21);
    await publish('0.2.11', 22);
    expect((await listReleaseNotes('0.2.9')).map((e) => e.version)).toEqual(['0.2.11', '0.2.10']);
    expect((await listReleaseNotes('0.2.11')).map((e) => e.version)).toEqual([]);
    // An unparseable stored value means "no floor" rather than an error — the
    // client's own storage is the only thing that can be malformed here.
    expect((await listReleaseNotes('dev')).map((e) => e.version)).toHaveLength(3);
  });

  it('keeps a release with no highlights, so the `since` window stays correct', async () => {
    await publish('0.2.61', 30, []);
    await publish('0.2.62', 31);
    // The quiet nightly is on record...
    expect((await listReleaseNotes()).map((e) => e.version)).toEqual(['0.2.62', '0.2.61']);
    // ...and a client sitting on it still gets told about the next one.
    expect((await listReleaseNotes('0.2.61')).map((e) => e.version)).toEqual(['0.2.62']);
  });

  it('returns the newest release for the first-run baseline, or null on an empty table', async () => {
    expect(await latestReleaseNote()).toBeNull();
    await publish('0.2.9', 20);
    await publish('0.2.10', 21);
    expect((await latestReleaseNote())?.version).toBe('0.2.10');
  });
});
