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
