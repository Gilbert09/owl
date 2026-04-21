import type { TaskPriority, GenerateTaskMetadataResponse } from '@fastowl/shared';
import { pickGenerationEnv, runClaudeCli } from './claudeCli.js';

/**
 * AI helpers for background generation: task title refinement, task
 * metadata, and commit messages.
 *
 * All calls fan out to a daemon's local `claude` CLI rather than
 * hitting the Anthropic API directly. That way we don't manage a
 * backend API key and each user's calls bill against their own
 * Claude subscription. See `claudeCli.ts` for the transport details.
 *
 * Every helper has a deterministic fallback (first-N-chars of the
 * prompt, etc.) so a missing daemon never blocks task creation —
 * the feature degrades to "no LLM polish" rather than to "task fails".
 */

/**
 * True when at least one daemon is connected and could service a
 * background CLI call. The metadata route uses this to decide whether
 * to call Claude at all or to immediately return the placeholder.
 */
export function isConfigured(): boolean {
  return pickGenerationEnv(null) !== null;
}

/**
 * Heuristic: is this title still the placeholder the modal sets at
 * task-create time (the prompt's first ~60 chars), rather than a
 * proper LLM-generated title? Used by `/start` to know whether to
 * refine the title inline before deriving a branch slug from it —
 * branches like `fastowl/abc-fix-the-bug-where-i-keep` look bad and
 * are the visible side-effect of a late-arriving title.
 */
export function looksLikePlaceholderTitle(
  title: string | null | undefined,
  prompt: string | null | undefined
): boolean {
  if (!title || !prompt) return false;
  const t = title.trim();
  const p = prompt.trim();
  if (!t || !p) return false;
  // Modal default is exactly `prompt.slice(0, 60).trim()`.
  return t === p.slice(0, 60).trim();
}

/**
 * Generate a concise (≤60 char) title for a task from its prompt.
 * Called fire-and-forget after task create; the result is patched in
 * via `task:update` WS event so the desktop replaces the placeholder
 * without a manual refresh.
 */
export async function generateTaskTitle(
  prompt: string,
  preferredEnvId?: string | null
): Promise<string> {
  const fallback = prompt.slice(0, 60).trim() || 'New Task';
  const envId = pickGenerationEnv(preferredEnvId);
  if (!envId) return fallback;

  const fullPrompt =
    'You produce concise task titles. Respond with the title only — ' +
    'no commentary, no quotes, no markdown, no trailing punctuation. ' +
    'Maximum 60 characters.\n\n' +
    `Generate a title for this task:\n\n${prompt}`;

  try {
    const text = await runClaudeCli(envId, fullPrompt);
    const cleaned = text.trim().replace(/^["']|["']$/g, '').slice(0, 60);
    return cleaned || fallback;
  } catch (err) {
    console.error('[ai] generateTaskTitle failed:', err);
    return fallback;
  }
}

/**
 * Generate task title + description + suggested priority from a prompt.
 * Used by the create-task modal's metadata route.
 */
export async function generateTaskMetadata(
  prompt: string,
  preferredEnvId?: string | null
): Promise<GenerateTaskMetadataResponse> {
  const fallback: GenerateTaskMetadataResponse = {
    title: prompt.slice(0, 60).trim() || 'New Task',
    description: prompt.slice(0, 200).trim(),
    suggestedPriority: 'medium',
  };
  const envId = pickGenerationEnv(preferredEnvId);
  if (!envId) return fallback;

  const fullPrompt =
    'You generate task metadata. Output ONLY a JSON object on a single ' +
    'line, no commentary, no markdown fences. Schema: ' +
    '{"title": string (≤60 chars), "description": string (1-2 sentences), ' +
    '"suggestedPriority": "low" | "medium" | "high" | "urgent"}.\n\n' +
    `Generate metadata for this prompt:\n\n${prompt}`;

  try {
    const text = await runClaudeCli(envId, fullPrompt);
    const cleaned = text.trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      title: String(parsed.title || fallback.title).slice(0, 60),
      description: String(parsed.description || fallback.description).slice(0, 500),
      suggestedPriority: validatePriority(parsed.suggestedPriority),
    };
  } catch (err) {
    console.error('[ai] generateTaskMetadata failed:', err);
    return fallback;
  }
}

function validatePriority(priority: unknown): TaskPriority {
  if (priority === 'low' || priority === 'medium' || priority === 'high' || priority === 'urgent') {
    return priority;
  }
  return 'medium';
}

/**
 * Generate a PR title + body from the task's diff. Title always
 * follows Conventional Commits; body either fills in the repo's PR
 * template (if found by the caller and passed in) or is generated
 * from scratch.
 *
 * The caller is responsible for locating the template file on the
 * env's working directory (e.g. `.github/pull_request_template.md`)
 * and passing its raw content — this function doesn't hit the
 * filesystem itself.
 *
 * Falls back to `{ title: task.title, body: quoted prompt }` on any
 * failure so `openPullRequestForTask` always has something to send
 * to GitHub.
 */
export async function generatePullRequestContent(opts: {
  taskTitle: string;
  prompt?: string;
  diffStat?: string;
  diff?: string;
  templateContent?: string;
  preferredEnvId?: string | null;
}): Promise<{ title: string; body: string }> {
  const fallback = {
    title: opts.taskTitle.slice(0, 72),
    body: buildPrBodyFallback(opts.prompt),
  };
  const envId = pickGenerationEnv(opts.preferredEnvId);
  if (!envId) return fallback;

  const diffBudget = 6000;
  const truncatedDiff =
    opts.diff && opts.diff.length > diffBudget
      ? opts.diff.slice(0, diffBudget) + '\n\n[… diff truncated …]'
      : opts.diff ?? '';

  const bodyInstruction = opts.templateContent
    ? 'For the body: FILL IN the repository PR template below. Preserve the ' +
      'template structure exactly — headings, checkboxes, order — and fill ' +
      'each section based on the diff. If a section asks for something the ' +
      'diff does not cover (e.g. breaking-change notes when there are none), ' +
      'say "N/A". Leave checkboxes unchecked unless the diff clearly satisfies ' +
      'the item.'
    : 'For the body: write a GitHub-style PR description. Start with a one- ' +
      'or two-sentence summary of what the PR does. Then a short "Changes" ' +
      'bullet list of the main edits. Then any notable caveats or follow-ups ' +
      '(or omit if none). Keep it under ~200 words.';

  const system =
    'You produce GitHub pull-request titles and descriptions for a single PR. ' +
    'Output ONLY a JSON object with keys "title" and "body" — no prose, no ' +
    'markdown fences, no extra keys. ' +
    'Title rules: follow Conventional Commits exactly — lowercase type prefix ' +
    'from {feat, fix, chore, refactor, docs, test, perf, build, ci, style}, ' +
    'optional scope in parens, colon, space, then a short lowercase summary. ' +
    '≤72 chars. Pick the type from the diff (feat = new behaviour, fix = bug ' +
    'fix, refactor = no behaviour change, etc). No period at the end. ' +
    bodyInstruction +
    ' Describe what the DIFF does — do not paraphrase or echo the task prompt. ' +
    'Never mention AI, Claude, FastOwl, tooling, or the task system in the ' +
    'title or body.';

  const sections: string[] = [system];
  if (opts.templateContent) {
    sections.push(
      'PR TEMPLATE (fill this in for the body):\n```\n' +
        opts.templateContent.slice(0, 4000) +
        '\n```'
    );
  }
  if (opts.diffStat) sections.push('Diff stat:\n' + opts.diffStat);
  if (truncatedDiff) sections.push('Diff:\n' + truncatedDiff);

  try {
    const raw = await runClaudeCli(envId, sections.join('\n\n'));
    const cleaned = raw
      .trim()
      .replace(/^```[a-z]*\n?|\n?```$/g, '')
      .trim();
    const parsed = JSON.parse(cleaned) as { title?: unknown; body?: unknown };
    const title =
      typeof parsed.title === 'string' && parsed.title.trim().length > 0
        ? parsed.title.trim().slice(0, 100)
        : fallback.title;
    const body =
      typeof parsed.body === 'string' && parsed.body.trim().length > 0
        ? parsed.body.trim()
        : fallback.body;
    return { title, body };
  } catch (err) {
    console.error('[ai] generatePullRequestContent failed:', err);
    return fallback;
  }
}

function buildPrBodyFallback(prompt?: string): string {
  if (!prompt || !prompt.trim()) return '';
  const quoted = prompt
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return '**Task prompt**\n\n' + quoted;
}

/**
 * Generate a commit message for an approved task from its diff. We
 * deliberately DO NOT pass the user's original prompt as LLM context
 * — a commit message should describe what the code does now, not
 * what the user asked for. Past output included the prompt verbatim,
 * either because the fallback path was firing or because Haiku was
 * echoing the context it saw.
 *
 * Diff is truncated to keep the prompt bounded — Haiku is fast and
 * cheap but we'd still rather not send a 500k-line renames-only
 * diff. Falls back to the task title alone on any failure.
 */
export async function generateCommitMessage(opts: {
  title: string;
  prompt?: string;
  diffStat?: string;
  diff?: string;
  preferredEnvId?: string | null;
}): Promise<string> {
  const fallback = opts.title.slice(0, 72);
  const envId = pickGenerationEnv(opts.preferredEnvId);
  if (!envId) return fallback;

  const diffBudget = 6000;
  const truncatedDiff =
    opts.diff && opts.diff.length > diffBudget
      ? opts.diff.slice(0, diffBudget) + '\n\n[… diff truncated …]'
      : opts.diff ?? '';

  const sections: string[] = [
    'You write git commit messages in the Conventional Commits style. ' +
      'Respond with the commit message only — no commentary, no markdown ' +
      'fences, no quotes, no prefixes like "Commit message:". First line ' +
      'is a concise subject (≤72 chars, lowercase type prefix like ' +
      'feat:/fix:/chore: when it fits). If the change is non-trivial, ' +
      'add a blank line and a short body explaining the WHY, wrapped ' +
      'at ~72 chars. ' +
      'Describe what the DIFF actually does — do NOT paraphrase or copy ' +
      'any task-description or user-intent you see elsewhere. Never ' +
      'mention the AI, the tooling, or the task system.',
    `Reference task title (for context only, do NOT copy verbatim): ${opts.title}`,
  ];
  if (opts.diffStat) sections.push(`Diff stat:\n${opts.diffStat}`);
  if (truncatedDiff) sections.push(`Diff:\n${truncatedDiff}`);

  try {
    const text = await runClaudeCli(envId, sections.join('\n\n'));
    const message = text.trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
    if (!message) return fallback;

    // Echo detection: if the model just returned the task's prompt
    // back (±whitespace), treat as a fallback. Keeps the "prompt
    // appears verbatim" bug from silently regressing.
    if (opts.prompt && looksLikeEcho(message, opts.prompt)) {
      console.warn('[ai] generateCommitMessage returned the user prompt; falling back');
      return fallback;
    }
    return message;
  } catch (err) {
    console.error('[ai] generateCommitMessage failed:', err);
    return fallback;
  }
}

function looksLikeEcho(message: string, prompt: string): boolean {
  const m = message.trim().toLowerCase();
  const p = prompt.trim().toLowerCase();
  if (!p) return false;
  return m === p || m.includes(p) || p.includes(m);
}
