// Release notes — the "What's new" feed behind the modal both front ends show
// after an update.
//
// Talyn cuts a stable release EVERY NIGHT, and most nights carry a handful of
// commits that no user would notice. Two consequences shape everything here:
//
//   1. The unit the user sees is not a release, it's the span between the
//      version they last saw and the one they're running — which may be a
//      dozen nightlies. `shouldShowWhatsNew` returns that span, and returns
//      nothing at all when the span has no user-facing content.
//   2. What reaches a highlight has to be filtered twice: once mechanically
//      (`filterReleaseCommits`, which drops merge commits, non-user commit
//      types, and internal scopes), and once editorially by the model in CI.
//
// Everything in this file is pure and lives in @talyn/shared on purpose. The
// CI generator, the backend, the desktop renderer and apps/web all depend on
// the same version ordering and the same show/don't-show rule; `apps/web` is a
// deliberate fork of the desktop renderer, so a second copy of this logic is
// how the two clients start disagreeing about what a user has already seen.

/** What kind of change a highlight describes. Drives the modal's icon. */
export type HighlightKind = 'feature' | 'fix' | 'improvement';

/** Which client a highlight is relevant to. A change can land on both. */
export type ReleaseSurface = 'desktop' | 'web';

/** One user-facing line in the modal. Written by the CI generator. */
export interface ReleaseHighlight {
  /** Short, sentence case, no trailing period. */
  title: string;
  /** One sentence, written for a user rather than for a reviewer. */
  description: string;
  kind: HighlightKind;
  /**
   * Non-empty. A highlight that applies to neither client should not have
   * been generated at all.
   */
  surfaces: ReleaseSurface[];
}

/** One release, as served by `GET /api/v1/release-notes`. */
export interface ReleaseNoteEntry {
  /** `X.Y.Z`, matching the GitHub release tag without the `v`. */
  version: string;
  /** ISO 8601. */
  publishedAt: string;
  /**
   * May be empty: a nightly with nothing user-facing still gets a row, so the
   * `?since=` window stays correct and the version is never re-summarised.
   */
  highlights: ReleaseHighlight[];
}

// ============================================================================
// Versions
// ============================================================================

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** `"v0.2.61"` / `"0.2.61"` → `{0, 2, 61}`. `null` for anything else. */
export function parseVersion(value: string | null | undefined): ParsedVersion | null {
  if (!value) return null;
  const m = VERSION_RE.exec(value.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * A single orderable integer for a version — what `release_notes.sort_key`
 * stores, so `?since=` is one indexed comparison rather than a string sort
 * (`"0.2.9"` sorts after `"0.2.10"` as text).
 *
 * The 10^6 stride per component is not decoration: Talyn ships a patch every
 * night, so a 10^3 stride would collide after under three years. At 10^6 the
 * result stays an exact JS integer (< 2^53) for any major below ~9000.
 */
export function versionSortKey(value: string | ParsedVersion): number {
  const v = typeof value === 'string' ? parseVersion(value) : value;
  if (!v) return -1;
  return v.major * 1_000_000_000_000 + v.minor * 1_000_000 + v.patch;
}

/** Standard comparator: negative when `a` is older. Unparseable sorts first. */
export function compareVersions(a: string, b: string): number {
  return versionSortKey(a) - versionSortKey(b);
}

// ============================================================================
// Commit filtering
// ============================================================================

export interface ParsedCommit {
  /** `feat`, `fix`, `chore`, … */
  type: string;
  /** The `(scope)`, when present. */
  scope: string | null;
  /** The subject with the type/scope prefix and the trailing `(#N)` removed. */
  subject: string;
  /** The PR number from a trailing `(#N)`, when the commit was squash-merged. */
  pr: number | null;
  /** The line as it appeared, for prompts and debugging. */
  raw: string;
}

const CONVENTIONAL_RE =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?!?: (?<subject>.+?)(?:\s\(#(?<pr>\d+)\))?$/i;

/**
 * Parses a conventional-commit subject line. Returns `null` for anything that
 * isn't one — including the `Merge pull request #N from …` commits GitHub
 * writes on a merge-commit merge, which is exactly what we want dropped.
 *
 * The trailing `(#N)` is optional because only squash merges through the
 * GitHub UI carry it; most of Talyn's commits land by direct push and have no
 * PR number at all.
 */
export function parseConventionalCommit(subject: string): ParsedCommit | null {
  const line = subject.split('\n')[0]?.trim() ?? '';
  if (!line) return null;
  const m = CONVENTIONAL_RE.exec(line);
  if (!m?.groups) return null;
  return {
    type: m.groups.type.toLowerCase(),
    scope: m.groups.scope?.toLowerCase() ?? null,
    subject: m.groups.subject.trim(),
    pr: m.groups.pr ? Number(m.groups.pr) : null,
    raw: line,
  };
}

/**
 * Commit types that can produce a highlight. `docs`, `chore`, `refactor`,
 * `test`, `ci`, `style` and `build` never describe something a user of the app
 * can observe, so they never reach the model.
 */
export const USER_FACING_TYPES: readonly string[] = ['feat', 'fix', 'perf'];

/**
 * Scopes whose changes a Talyn user cannot see from inside the app:
 * `admin`/`fleet` are the operator console (admin.talyn.dev), `marketing` is
 * the public website, and the rest are build/observability plumbing.
 *
 * Exported so the list can be tuned without editing the filter.
 */
export const INTERNAL_SCOPES: readonly string[] = [
  'admin',
  'fleet',
  'ci',
  'debug',
  'deps',
  'build',
  'test',
  'marketing',
  'docs',
];

/**
 * The mechanical pre-filter: what the model in CI is even allowed to consider.
 * Everything it drops is dropped without judgement; everything it keeps is
 * still subject to the model's editorial pass, which is where "would a user
 * notice this?" gets answered.
 */
export function filterReleaseCommits(subjects: readonly string[]): ParsedCommit[] {
  const kept: ParsedCommit[] = [];
  for (const subject of subjects) {
    const parsed = parseConventionalCommit(subject);
    if (!parsed) continue;
    if (!USER_FACING_TYPES.includes(parsed.type)) continue;
    if (parsed.scope && INTERNAL_SCOPES.includes(parsed.scope)) continue;
    kept.push(parsed);
  }
  return kept;
}

/**
 * Which clients a commit's scope implies. `desktop` and `web` are the two
 * forks; everything else (backend, shared, a bare scope-less commit) reaches
 * both. A starting point for the generator — the model may override it when
 * the subject says otherwise.
 */
export function surfacesForScope(scope: string | null): ReleaseSurface[] {
  if (scope === 'desktop') return ['desktop'];
  if (scope === 'web') return ['web'];
  return ['desktop', 'web'];
}

/** The `kind` a commit type implies, before the model refines it. */
export function kindForCommitType(type: string): HighlightKind {
  if (type === 'feat') return 'feature';
  if (type === 'perf') return 'improvement';
  return 'fix';
}

// ============================================================================
// What to show, and what to remember having shown
// ============================================================================

export interface WhatsNewInput {
  /**
   * The newest version this client has already shown, or `null` on a first
   * run. A first run shows nothing — a brand-new user does not want a
   * changelog, they want the app.
   */
  lastSeenVersion: string | null;
  /**
   * The version actually running, when the client has an orderable one. The
   * desktop passes its semver; `apps/web` passes `null`, because its build id
   * is a commit sha (`web/<sha>`) that cannot be compared — and because web is
   * continuously deployed, so it is always at or ahead of the latest cut.
   */
  currentVersion: string | null;
  /** Whatever the backend returned, in any order. */
  entries: readonly ReleaseNoteEntry[];
  /** Which client is asking. Highlights for the other one are dropped. */
  surface: ReleaseSurface;
}

function relevant(input: WhatsNewInput): ReleaseNoteEntry[] {
  const lastSeen = parseVersion(input.lastSeenVersion);
  if (!lastSeen) return [];
  const lastSeenKey = versionSortKey(lastSeen);

  // The ceiling matters on the desktop: the backend knows about tonight's
  // release the moment CI posts it, but the user is still running last
  // night's build. Showing them a feature they don't have yet would both
  // confuse them AND burn the entry — they'd never see it again after the
  // update actually landed.
  const current = parseVersion(input.currentVersion);
  const ceiling = current ? versionSortKey(current) : Number.POSITIVE_INFINITY;

  return input.entries
    .filter((e) => {
      const key = versionSortKey(e.version);
      return key > lastSeenKey && key <= ceiling;
    })
    .sort((a, b) => versionSortKey(b.version) - versionSortKey(a.version));
}

/**
 * Drop every highlight that doesn't apply to this client, and every entry
 * thereby left empty.
 *
 * Used on both paths into the modal — the launch check below and the
 * Settings → About button, which reads the whole changelog rather than a span.
 * Shared so the two cannot disagree about what a release contains: a desktop
 * user opening the changelog should not see the line about a web-only change
 * simply because they arrived from a different button.
 */
export function highlightsForSurface(
  entries: readonly ReleaseNoteEntry[],
  surface: ReleaseSurface
): ReleaseNoteEntry[] {
  return entries
    .map((entry) => ({
      ...entry,
      highlights: entry.highlights.filter((h) => h.surfaces.includes(surface)),
    }))
    .filter((entry) => entry.highlights.length > 0);
}

/**
 * The entries to render on launch, newest first. An empty result means: show
 * nothing.
 */
export function shouldShowWhatsNew(input: WhatsNewInput): ReleaseNoteEntry[] {
  return highlightsForSurface(relevant(input), input.surface);
}

/**
 * The version to persist as "seen" once the modal is dismissed.
 *
 * Deliberately NOT the newest entry the client rendered: a release whose
 * highlights were all for the other surface still counts as seen, or every
 * launch re-fetches and re-evaluates it forever. Equally deliberately NOT the
 * newest entry the backend returned — that can be a release the user hasn't
 * installed yet, and recording it would swallow those notes.
 */
export function nextSeenVersion(input: WhatsNewInput): string | null {
  const inRange = relevant(input);
  if (inRange.length === 0) return input.lastSeenVersion;
  return inRange[0].version;
}
