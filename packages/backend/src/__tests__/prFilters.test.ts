import { describe, expect, it } from 'vitest';
import {
  MAX_PR_FILTER_NAME_LENGTH,
  prFilterIsEmpty,
  prMatchesAnyFilter,
  prMatchesFilter,
  validatePRFilters,
  type PRFilterCriteria,
  type PRFilterTarget,
} from '@talyn/shared';

function row(opts: {
  owner?: string;
  repo?: string;
  title?: string;
  author?: string;
  labels?: string[];
}): PRFilterTarget {
  return {
    owner: opts.owner ?? 'PostHog',
    repo: opts.repo ?? 'posthog',
    summary: {
      title: opts.title ?? 'fix(pr-list): settle the mergeable verdict',
      author: opts.author ?? 'gilbert09',
      labels: opts.labels,
    },
  };
}

/** A valid definition wrapper so the tests only vary the interesting part. */
function def(criteria: unknown, over: Record<string, unknown> = {}) {
  return [
    {
      id: 'f1',
      name: 'Frontend',
      criteria,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...over,
    },
  ];
}

describe('prMatchesFilter', () => {
  it('matches every PR when the filter constrains nothing', () => {
    expect(prMatchesFilter(row({}), {})).toBe(true);
    expect(prFilterIsEmpty({})).toBe(true);
  });

  it.each<[string, PRFilterCriteria, boolean]>([
    ['repo hit', { repos: ['PostHog/posthog'] }, true],
    ['repo hit, different case', { repos: ['posthog/POSTHOG'] }, true],
    ['repo miss', { repos: ['PostHog/posthog.com'] }, false],
    ['repo hit among several', { repos: ['a/b', 'PostHog/posthog'] }, true],
    ['author hit', { authors: ['Gilbert09'] }, true],
    ['author miss', { authors: ['octocat'] }, false],
    ['title substring hit', { titleContains: 'MERGEABLE' }, true],
    ['title substring miss', { titleContains: 'feat(' }, false],
    ['empty list is no constraint', { repos: [] }, true],
    ['whitespace-only title is no constraint', { titleContains: '   ' }, true],
  ])('%s', (_name, criteria, expected) => {
    expect(prMatchesFilter(row({}), criteria)).toBe(expected);
  });

  it.each<[string, string[] | undefined, PRFilterCriteria, boolean]>([
    ['any: one of two present', ['bug', 'frontend'], { labels: ['frontend', 'backend'] }, true],
    ['any: none present', ['bug'], { labels: ['frontend', 'backend'] }, false],
    ['all: both present', ['bug', 'frontend'], { labels: ['bug', 'frontend'], labelMatch: 'all' }, true],
    ['all: one missing', ['bug'], { labels: ['bug', 'frontend'], labelMatch: 'all' }, false],
    ['label case is ignored', ['Frontend'], { labels: ['frontend'] }, true],
    ['exclude hits', ['wip'], { excludeLabels: ['wip'] }, false],
    ['exclude misses', ['bug'], { excludeLabels: ['wip'] }, true],
    [
      'exclude beats a satisfied include',
      ['frontend', 'wip'],
      { labels: ['frontend'], excludeLabels: ['wip'] },
      false,
    ],
    // A row cached before labels shipped in the summary carries none. It does
    // not say the PR has the label, so an include criterion must not match —
    // and an EXCLUDE criterion must not reject it either.
    ['unknown labels fail an include', undefined, { labels: ['frontend'] }, false],
    ['unknown labels pass an exclude', undefined, { excludeLabels: ['wip'] }, true],
  ])('labels — %s', (_name, labels, criteria, expected) => {
    expect(prMatchesFilter(row({ labels }), criteria)).toBe(expected);
  });

  it('ANDs the criteria within one filter', () => {
    const criteria: PRFilterCriteria = {
      repos: ['PostHog/posthog'],
      labels: ['frontend'],
      titleContains: 'fix(',
    };
    expect(prMatchesFilter(row({ labels: ['frontend'] }), criteria)).toBe(true);
    // Same PR, wrong repo — one failed criterion is enough.
    expect(prMatchesFilter(row({ repo: 'posthog.com', labels: ['frontend'] }), criteria)).toBe(
      false
    );
  });
});

describe('prMatchesAnyFilter', () => {
  it('places no constraint when nothing is selected', () => {
    expect(prMatchesAnyFilter(row({}), [])).toBe(true);
  });

  it('ORs the selected filters, so picking two shows both', () => {
    const frontend: PRFilterCriteria = { labels: ['frontend'] };
    const backend: PRFilterCriteria = { labels: ['backend'] };
    expect(prMatchesAnyFilter(row({ labels: ['frontend'] }), [frontend, backend])).toBe(true);
    expect(prMatchesAnyFilter(row({ labels: ['backend'] }), [frontend, backend])).toBe(true);
    expect(prMatchesAnyFilter(row({ labels: ['docs'] }), [frontend, backend])).toBe(false);
  });
});

describe('validatePRFilters', () => {
  it('accepts and normalises a filter', () => {
    const out = validatePRFilters(
      def({
        repos: ['  PostHog/posthog  ', 'PostHog/posthog', ''],
        labels: [' frontend '],
        titleContains: '  fix(  ',
      })
    );
    expect(out).toHaveLength(1);
    expect(out[0].criteria).toEqual({
      repos: ['PostHog/posthog'],
      labels: ['frontend'],
      titleContains: 'fix(',
    });
    expect(out[0].name).toBe('Frontend');
  });

  it('drops criteria keys that normalise to nothing', () => {
    const out = validatePRFilters(def({ labels: ['bug'], repos: ['   '], excludeLabels: [] }));
    expect(Object.keys(out[0].criteria)).toEqual(['labels']);
  });

  it('keeps labelMatch: all', () => {
    const out = validatePRFilters(def({ labels: ['a', 'b'], labelMatch: 'all' }));
    expect(out[0].criteria.labelMatch).toBe('all');
  });

  it('stamps missing timestamps rather than rejecting', () => {
    const out = validatePRFilters(
      def({ labels: ['bug'] }, { createdAt: undefined, updatedAt: undefined })
    );
    expect(out[0].createdAt).toMatch(/^\d{4}-/);
    expect(out[0].updatedAt).toMatch(/^\d{4}-/);
  });

  it('accepts an empty list (the user deleted their last filter)', () => {
    expect(validatePRFilters([])).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['not an array', { id: 'f1' }],
    ['entry is not an object', ['nope']],
    ['missing id', def({ labels: ['bug'] }, { id: undefined })],
    ['blank name', def({ labels: ['bug'] }, { name: '   ' })],
    [
      'over-long name',
      def({ labels: ['bug'] }, { name: 'x'.repeat(MAX_PR_FILTER_NAME_LENGTH + 1) }),
    ],
    ['missing criteria', def(undefined)],
    ['criteria is an array', def([])],
    ['unknown criteria key', def({ labels: ['bug'], mergeable: true })],
    ['non-string list member', def({ labels: [1] })],
    ['bad labelMatch', def({ labels: ['a'], labelMatch: 'either' })],
    ['non-string titleContains', def({ titleContains: 7 })],
    // A filter with no criteria would match every PR — a saved view that
    // filters nothing, which the UI also refuses to create.
    ['no criteria at all', def({})],
  ])('rejects %s', (_name, value) => {
    expect(() => validatePRFilters(value)).toThrow();
  });

  it('rejects a duplicate id, which would break the React key and the toggle', () => {
    const [one] = def({ labels: ['bug'] });
    expect(() => validatePRFilters([one, { ...one, name: 'Other' }])).toThrow(/duplicate/);
  });
});
