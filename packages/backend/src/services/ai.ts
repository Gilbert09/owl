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
 * Generate a commit message for an approved task from its title +
 * prompt + diff. Diff is truncated to keep the prompt bounded — Haiku
 * is fast and cheap but we'd still rather not send a 500k-line
 * renames-only diff. Falls back to `<title>\n\n<prompt>` on any
 * failure — better to commit something unglamorous than to block
 * the approve flow.
 */
export async function generateCommitMessage(opts: {
  title: string;
  prompt?: string;
  diffStat?: string;
  diff?: string;
  preferredEnvId?: string | null;
}): Promise<string> {
  const fallback = buildCommitFallback(opts.title, opts.prompt);
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
      'fences, no quotes. First line is a concise subject (≤72 chars, ' +
      'lowercase type prefix like feat:/fix:/chore: when it fits). If the ' +
      'change is non-trivial, add a blank line and a short body explaining ' +
      'the why, wrapped at ~72 chars. Never mention the AI, the tooling, ' +
      'or the task system.',
    `Task title: ${opts.title}`,
  ];
  if (opts.prompt) sections.push(`Original prompt:\n${opts.prompt}`);
  if (opts.diffStat) sections.push(`Diff stat:\n${opts.diffStat}`);
  if (truncatedDiff) sections.push(`Diff:\n${truncatedDiff}`);

  try {
    const text = await runClaudeCli(envId, sections.join('\n\n'));
    const message = text.trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
    return message || fallback;
  } catch (err) {
    console.error('[ai] generateCommitMessage failed:', err);
    return fallback;
  }
}

function buildCommitFallback(title: string, prompt?: string): string {
  const subject = title.slice(0, 72);
  const body = prompt && prompt.trim() && prompt.trim() !== title.trim() ? prompt.trim() : '';
  return body ? `${subject}\n\n${body}` : subject;
}
