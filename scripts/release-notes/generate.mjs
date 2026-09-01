#!/usr/bin/env node
/**
 * Generate a release's "What's new" highlights from its commits and post them
 * to the backend.
 *
 * Run by the `release-notes` job in .github/workflows/publish.yml, after the
 * macOS leg has created the GitHub release — so a version that failed to build
 * is never announced.
 *
 * The pipeline is: compare the previous release tag to HEAD → keep only the
 * commits that could possibly matter to a user (`filterReleaseCommits` from
 * @talyn/shared, the same filter the tests pin) → ask Claude to turn what
 * survives into user-facing highlights → POST them.
 *
 * Two filters, deliberately. The mechanical one drops merge commits,
 * non-user commit types, and internal scopes without any judgement; the model
 * answers the judgement question ("would a user notice this?") on what's left.
 * Either one alone gets it wrong: the filter can't tell a plumbing `fix(github)`
 * from a visible one, and the model shouldn't be spending attention on
 * `chore(deps)`.
 *
 * Nothing here may fail a release. The job is `continue-on-error`, this script
 * exits 0 on every soft failure, and an empty highlight list is a normal
 * outcome that still gets posted (the row is what keeps `?since=` honest).
 *
 * Usage:
 *   node scripts/release-notes/generate.mjs [--dry-run]
 *
 * Env:
 *   GITHUB_REPOSITORY            owner/repo
 *   GITHUB_TOKEN                 for the compare API
 *   PREVIOUS_TAG                 the release before this one, e.g. v0.2.60
 *   HEAD_SHA                     the commit being released
 *   RELEASE_VERSION              X.Y.Z (no leading v)
 *   ANTHROPIC_API_KEY            omit to skip generation entirely
 *   TALYN_API_URL                backend root, e.g. https://prod.talyn.dev
 *   TALYN_RELEASE_INGEST_SECRET  omit to skip the POST
 */
import Anthropic from '@anthropic-ai/sdk';
import { filterReleaseCommits, surfacesForScope, kindForCommitType } from '@talyn/shared';

const DRY_RUN = process.argv.includes('--dry-run');

/** Soft failure: say why, leave the release alone. */
function skip(reason) {
  console.log(`release-notes: skipping — ${reason}`);
  process.exit(0);
}

const {
  GITHUB_REPOSITORY,
  GITHUB_TOKEN,
  PREVIOUS_TAG,
  HEAD_SHA,
  RELEASE_VERSION,
  ANTHROPIC_API_KEY,
  TALYN_API_URL,
  TALYN_RELEASE_INGEST_SECRET,
} = process.env;

if (!RELEASE_VERSION) skip('RELEASE_VERSION is not set');
if (!GITHUB_REPOSITORY) skip('GITHUB_REPOSITORY is not set');
if (!PREVIOUS_TAG) skip('no previous release to compare against');
if (!HEAD_SHA) skip('HEAD_SHA is not set');
if (!ANTHROPIC_API_KEY) skip('ANTHROPIC_API_KEY is not set');
if (!DRY_RUN && !TALYN_RELEASE_INGEST_SECRET) skip('TALYN_RELEASE_INGEST_SECRET is not set');
if (!DRY_RUN && !TALYN_API_URL) skip('TALYN_API_URL is not set');

// ---------------------------------------------------------------------------
// 1. The commits in this release
// ---------------------------------------------------------------------------

/**
 * Every commit between the previous release tag and HEAD.
 *
 * The compare endpoint pages its `commits` array, and `total_commits` reports
 * the true size — so a gap between the two is a real omission and gets said
 * out loud rather than quietly shortening the release notes.
 */
async function fetchCommitSubjects() {
  const subjects = [];
  let totalCommits = null;
  for (let page = 1; ; page += 1) {
    const url =
      `https://api.github.com/repos/${GITHUB_REPOSITORY}/compare/` +
      `${encodeURIComponent(PREVIOUS_TAG)}...${encodeURIComponent(HEAD_SHA)}` +
      `?per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub compare failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    totalCommits ??= body.total_commits ?? 0;
    const commits = body.commits ?? [];
    if (commits.length === 0) break;
    for (const c of commits) subjects.push(c.commit?.message ?? '');
    if (subjects.length >= totalCommits) break;
  }
  if (totalCommits != null && subjects.length < totalCommits) {
    console.warn(
      `release-notes: GitHub returned ${subjects.length} of ${totalCommits} commits ` +
        `for ${PREVIOUS_TAG}...${HEAD_SHA} — the notes below are generated from a ` +
        `partial range.`
    );
  }
  return subjects;
}

// ---------------------------------------------------------------------------
// 2. Turn the survivors into highlights
// ---------------------------------------------------------------------------

const HIGHLIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          kind: { type: 'string', enum: ['feature', 'fix', 'improvement'] },
          surfaces: {
            type: 'array',
            items: { type: 'string', enum: ['desktop', 'web'] },
          },
        },
        required: ['title', 'description', 'kind', 'surfaces'],
        additionalProperties: false,
      },
    },
  },
  required: ['highlights'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You write the "What's new" notes for Talyn, a desktop and web app for managing GitHub pull requests with cloud coding agents.

You are given the commits from one release. Turn them into the short list a Talyn user would want to read after an update.

What earns a highlight: something the user can see or do differently. New capabilities, changed behaviour they would notice, fixes to problems they would have hit, and speedups they would feel.

What does not: internal refactors, test changes, dependency bumps, build and CI work, logging and instrumentation, anything on the operator console or the marketing site, and fixes to bugs that only ever existed on an unreleased branch.

Merge commits that tell one story into one highlight. Three commits iterating on the same feature are one highlight describing the finished feature, not three.

Returning an empty list is a correct and common answer. Most nights contain nothing a user would notice. Do not manufacture a highlight to avoid an empty list.

For each highlight:
- title: under 60 characters, sentence case, no trailing period. Name the thing, not the change ("Watch a PR you did not write", not "Added PR watching").
- description: exactly one sentence, written for someone using the app. Say what they can now do or what now works. No commit-speak, no file paths, no PR or issue numbers, no function or table names, no mention of commits or releases.
- kind: "feature" for something new, "fix" for something repaired, "improvement" for something that got faster or better without being new.
- surfaces: which clients it applies to. A commit scoped (desktop) is desktop only, (web) is web only, everything else is both. Backend changes are almost always both.`;

async function generateHighlights(commits) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const lines = commits.map((c) => {
    const scope = c.scope ? `(${c.scope})` : '';
    const surfaces = surfacesForScope(c.scope).join('+');
    return `- ${c.type}${scope}: ${c.subject}  [kind hint: ${kindForCommitType(c.type)}; surfaces: ${surfaces}]`;
  });

  // No `effort` override: the default (high) is the documented setting for
  // intelligence-sensitive non-coding work, and this is the one place in the
  // pipeline where judgement actually happens. It is the first knob to turn if
  // the notes ever read as over- or under-selective.
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: HIGHLIGHTS_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `Release ${RELEASE_VERSION} contains these commits:\n\n${lines.join('\n')}`,
      },
    ],
  });

  // Check the stop reason before touching content: a refusal returns HTTP 200
  // with empty or partial content, and indexing into it would throw.
  if (response.stop_reason === 'refusal') {
    console.warn(
      `release-notes: the model declined this request (${response.stop_details?.category ?? 'no category'}) — ` +
        `posting an empty release instead. Worth looking at: a list of commit subjects should never trip this.`
    );
    return [];
  }

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  if (!text.trim()) throw new Error('model returned no text block');
  const parsed = JSON.parse(text);
  return normalize(parsed.highlights ?? []);
}

/**
 * Last-mile tidying the schema cannot express (structured outputs reject
 * `maxLength`), plus a hard drop of anything malformed — the backend validates
 * the same shape and would reject the whole POST for one bad entry.
 */
function normalize(raw) {
  const out = [];
  for (const h of raw) {
    const title = String(h?.title ?? '')
      .trim()
      .replace(/\.$/, '');
    const description = String(h?.description ?? '').trim();
    const surfaces = [...new Set(h?.surfaces ?? [])].filter((s) => s === 'desktop' || s === 'web');
    if (!title || !description || surfaces.length === 0) continue;
    if (!['feature', 'fix', 'improvement'].includes(h?.kind)) continue;
    out.push({ title, description, kind: h.kind, surfaces });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Publish
// ---------------------------------------------------------------------------

async function post(payload) {
  const res = await fetch(`${TALYN_API_URL.replace(/\/$/, '')}/api/v1/release-notes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Talyn-Release-Secret': TALYN_RELEASE_INGEST_SECRET,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const subjects = await fetchCommitSubjects();
  const commits = filterReleaseCommits(subjects);
  console.log(
    `release-notes: ${subjects.length} commit(s) in ${PREVIOUS_TAG}...${RELEASE_VERSION}, ` +
      `${commits.length} candidate(s) after filtering.`
  );

  // An empty candidate list still gets posted. The row is what makes the
  // `?since=` window correct for every client that later crosses this version.
  const highlights = commits.length > 0 ? await generateHighlights(commits) : [];
  console.log(`release-notes: ${highlights.length} highlight(s).`);

  const payload = {
    version: RELEASE_VERSION,
    publishedAt: new Date().toISOString(),
    highlights,
  };

  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  await post(payload);
  console.log(`release-notes: published ${RELEASE_VERSION}.`);
}

main().catch((err) => {
  // Soft failure on purpose. Release notes are auxiliary; a GitHub blip, an
  // Anthropic 529, or a backend deploy in flight must not turn into a red
  // publish run for a release that already shipped.
  console.error('release-notes: failed —', err?.message ?? err);
  process.exit(0);
});
