// Saved PR filters — the user's own named views over the PR list.
//
// A filter is workspace-scoped (it lives in `workspace.settings.prFilters`), so
// every client signed into the workspace sees the same set. The matcher below
// is the ONE definition of "this PR matches this filter": the desktop and the
// web app are deliberate forks of each other, and two copies of the predicate
// would let the same named filter show different PRs on each client.
//
// Criteria within a filter AND together (repo AND label AND title). Which is
// the opposite of how several SELECTED filters combine in the UI — those OR,
// because a saved filter is a view, and picking "Frontend" and "Backend"
// means "show me both", not "show me PRs that are somehow in both".

/** How a filter's `labels` list must match the PR's labels. */
export type PRFilterLabelMatch = 'any' | 'all';

/**
 * What a saved filter tests. Every field is optional; an absent (or empty)
 * field places no constraint at all. A filter with no constraints matches
 * every PR — {@link prFilterIsEmpty} spots that so the UI can refuse to save
 * one rather than shipping a view that filters nothing.
 */
export interface PRFilterCriteria {
  /**
   * Repositories, as `owner/repo` full names. Matches if the PR is in ANY of
   * them. Stored by full name rather than by repository id so a filter keeps
   * working if the repo is removed from the workspace and re-added (which
   * mints a new row id).
   */
  repos?: string[];
  /** GitHub labels the PR must carry, combined per {@link labelMatch}. */
  labels?: string[];
  /** Default `'any'`. */
  labelMatch?: PRFilterLabelMatch;
  /** Labels that EXCLUDE a PR — carrying any one of them fails the filter. */
  excludeLabels?: string[];
  /** Case-insensitive substring of the PR title (SQL `ilike '%…%'`). */
  titleContains?: string;
  /** GitHub logins. Matches if the PR's author is ANY of them. */
  authors?: string[];
}

/** A named, saved filter as persisted in `workspace.settings.prFilters`. */
export interface PRFilterDefinition {
  /** Stable id (uuid) — the React key, and what the UI toggles. */
  id: string;
  /** What the user called it. Shown on the chip in the PR filter bar. */
  name: string;
  criteria: PRFilterCriteria;
  createdAt: string;
  updatedAt: string;
}

/**
 * The subset of a PR row the matcher reads. Both the client `PRRow` and the
 * backend's row shape are structural supersets, so either can be passed.
 *
 * `summary.labels` is optional: rows cached before labels shipped in the
 * summary have none, and a label criterion treats that as "no labels", i.e.
 * it does not match. That is the honest reading — the row genuinely does not
 * say the PR carries the label — and it self-heals on the next poll.
 */
export interface PRFilterTarget {
  owner: string;
  repo: string;
  summary: {
    title?: string;
    author?: string;
    labels?: string[];
  };
}

/** Trim, drop empties, and lowercase — how every list criterion is compared. */
function normalizeList(values: string[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** True when a filter constrains nothing, so it would match every PR. */
export function prFilterIsEmpty(criteria: PRFilterCriteria): boolean {
  return (
    normalizeList(criteria.repos).length === 0 &&
    normalizeList(criteria.labels).length === 0 &&
    normalizeList(criteria.excludeLabels).length === 0 &&
    normalizeList(criteria.authors).length === 0 &&
    (criteria.titleContains ?? '').trim().length === 0
  );
}

/** Whether one PR satisfies every criterion of one filter. */
export function prMatchesFilter(row: PRFilterTarget, criteria: PRFilterCriteria): boolean {
  const repos = normalizeList(criteria.repos);
  if (repos.length > 0) {
    const full = `${row.owner}/${row.repo}`.toLowerCase();
    if (!repos.includes(full)) return false;
  }

  const authors = normalizeList(criteria.authors);
  if (authors.length > 0) {
    const author = (row.summary.author ?? '').toLowerCase();
    if (!author || !authors.includes(author)) return false;
  }

  const title = (criteria.titleContains ?? '').trim().toLowerCase();
  if (title) {
    if (!(row.summary.title ?? '').toLowerCase().includes(title)) return false;
  }

  const wanted = normalizeList(criteria.labels);
  const excluded = normalizeList(criteria.excludeLabels);
  if (wanted.length > 0 || excluded.length > 0) {
    const have = normalizeList(row.summary.labels);
    if (excluded.some((l) => have.includes(l))) return false;
    if (wanted.length > 0) {
      const ok =
        criteria.labelMatch === 'all'
          ? wanted.every((l) => have.includes(l))
          : wanted.some((l) => have.includes(l));
      if (!ok) return false;
    }
  }

  return true;
}

/**
 * Whether a PR passes the SELECTED filters: it matches at least one of them
 * (OR). No selection places no constraint, so the caller can apply this
 * unconditionally.
 */
export function prMatchesAnyFilter(row: PRFilterTarget, filters: PRFilterCriteria[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => prMatchesFilter(row, f));
}

/** Longest name a filter chip can carry without wrecking the filter bar. */
export const MAX_PR_FILTER_NAME_LENGTH = 60;

/**
 * Validate + normalise an untrusted `settings.prFilters` array. Throws with a
 * user-facing message on a bad shape so the route can 400 with it.
 *
 * Normalising here (not just checking) means the stored filter is already
 * trimmed and de-duplicated, so the matcher's own normalisation is a no-op on
 * anything that came through this door.
 */
export function validatePRFilters(raw: unknown): PRFilterDefinition[] {
  if (!Array.isArray(raw)) throw new Error('settings.prFilters must be an array');
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const at = `settings.prFilters[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} must be an object`);
    }
    const f = entry as Partial<PRFilterDefinition>;
    if (typeof f.id !== 'string' || f.id.trim().length === 0) {
      throw new Error(`${at}.id must be a non-empty string`);
    }
    if (seen.has(f.id)) throw new Error(`${at}.id is a duplicate`);
    seen.add(f.id);
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name) throw new Error(`${at}.name must be a non-empty string`);
    if (name.length > MAX_PR_FILTER_NAME_LENGTH) {
      throw new Error(`${at}.name must be ${MAX_PR_FILTER_NAME_LENGTH} characters or fewer`);
    }
    if (!f.criteria || typeof f.criteria !== 'object' || Array.isArray(f.criteria)) {
      throw new Error(`${at}.criteria must be an object`);
    }
    const c = f.criteria as Record<string, unknown>;
    const known = ['repos', 'labels', 'labelMatch', 'excludeLabels', 'titleContains', 'authors'];
    const unknown = Object.keys(c).filter((k) => !known.includes(k));
    if (unknown.length > 0) {
      throw new Error(`Unknown ${at}.criteria key "${unknown[0]}"`);
    }
    const stringList = (key: 'repos' | 'labels' | 'excludeLabels' | 'authors'): string[] | undefined => {
      const v = c[key];
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new Error(`${at}.criteria.${key} must be an array of strings`);
      }
      const cleaned = (v as string[]).map((x) => x.trim()).filter(Boolean);
      const deduped = [...new Set(cleaned)];
      return deduped.length > 0 ? deduped : undefined;
    };
    if (c.labelMatch !== undefined && c.labelMatch !== 'any' && c.labelMatch !== 'all') {
      throw new Error(`${at}.criteria.labelMatch must be "any" or "all"`);
    }
    if (c.titleContains !== undefined && typeof c.titleContains !== 'string') {
      throw new Error(`${at}.criteria.titleContains must be a string`);
    }
    const titleContains = (c.titleContains as string | undefined)?.trim() || undefined;
    const criteria: PRFilterCriteria = {
      repos: stringList('repos'),
      labels: stringList('labels'),
      labelMatch: c.labelMatch as PRFilterLabelMatch | undefined,
      excludeLabels: stringList('excludeLabels'),
      titleContains,
      authors: stringList('authors'),
    };
    // Drop the absent keys so the stored jsonb stays the shape it reads as.
    for (const k of Object.keys(criteria) as Array<keyof PRFilterCriteria>) {
      if (criteria[k] === undefined) delete criteria[k];
    }
    if (prFilterIsEmpty(criteria)) {
      throw new Error(`${at} ("${name}") sets no criteria, so it would match every PR`);
    }
    const stamp = (v: unknown): string =>
      typeof v === 'string' && v.length > 0 ? v : new Date().toISOString();
    return {
      id: f.id,
      name,
      criteria,
      createdAt: stamp(f.createdAt),
      updatedAt: stamp(f.updatedAt),
    };
  });
}
