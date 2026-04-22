import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isConfigured,
  looksLikePlaceholderTitle,
  generateTaskTitle,
  generateTaskMetadata,
  generatePullRequestContent,
  generateCommitMessage,
} from '../services/ai.js';
import * as claudeCli from '../services/claudeCli.js';

describe('ai — pure helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('returns false when no daemon is connected (pickGenerationEnv returns null)', () => {
      vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue(null);
      expect(isConfigured()).toBe(false);
    });

    it('returns true when a daemon is connected', () => {
      vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-any');
      expect(isConfigured()).toBe(true);
    });
  });

  describe('looksLikePlaceholderTitle', () => {
    it('is true when title equals prompt.slice(0,60).trim()', () => {
      const prompt = 'Fix the login bug where the redirect spins forever and the user cannot recover';
      const title = prompt.slice(0, 60).trim();
      expect(looksLikePlaceholderTitle(title, prompt)).toBe(true);
    });

    it('is false once the title diverges (LLM refined it)', () => {
      expect(looksLikePlaceholderTitle('Fix login redirect', 'fix the login bug'))
        .toBe(false);
    });

    it('is false on empty inputs', () => {
      expect(looksLikePlaceholderTitle('', 'x')).toBe(false);
      expect(looksLikePlaceholderTitle('x', '')).toBe(false);
      expect(looksLikePlaceholderTitle(undefined, undefined)).toBe(false);
      expect(looksLikePlaceholderTitle(null, null)).toBe(false);
    });
  });
});

describe('ai — generateTaskTitle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a 60-char-max fallback when no daemon is available', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue(null);
    const result = await generateTaskTitle(
      'Do the thing with the widget that keeps failing on monday mornings'
    );
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it('calls runClaudeCli when a daemon is available and trims quotes', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    const run = vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue(
      '"Refined title with quotes"'
    );

    const result = await generateTaskTitle('prompt body', 'env-1');
    expect(run).toHaveBeenCalledWith('env-1', expect.any(String));
    expect(result).toBe('Refined title with quotes');
    expect(result.startsWith('"')).toBe(false);
  });

  it('caps the returned title at 60 chars', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue(
      'A very long title that definitely exceeds the sixty-character budget we enforce'
    );
    const result = await generateTaskTitle('prompt');
    expect(result.length).toBe(60);
  });

  it('falls back to the prompt head when runClaudeCli throws', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockRejectedValue(new Error('timeout'));
    const result = await generateTaskTitle('Fix something that is broken');
    expect(result).toBe('Fix something that is broken');
  });
});

describe('ai — generateTaskMetadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the fallback when no daemon is available', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue(null);
    const meta = await generateTaskMetadata('prompt body');
    expect(meta.title.length).toBeLessThanOrEqual(60);
    expect(meta.suggestedPriority).toBe('medium');
  });

  it('parses a clean JSON response', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue(
      JSON.stringify({
        title: 'Add login flow',
        description: 'Wire up the Supabase OAuth callback and session persistence.',
        suggestedPriority: 'high',
      })
    );
    const meta = await generateTaskMetadata('Add a login flow');
    expect(meta.title).toBe('Add login flow');
    expect(meta.description).toMatch(/Supabase/);
    expect(meta.suggestedPriority).toBe('high');
  });

  it('strips markdown code fences before parsing', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue(
      '```json\n{"title":"OK","description":"d","suggestedPriority":"urgent"}\n```'
    );
    const meta = await generateTaskMetadata('x');
    expect(meta.title).toBe('OK');
    expect(meta.suggestedPriority).toBe('urgent');
  });

  it('falls back to the placeholder on malformed JSON', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue('not json at all');
    const meta = await generateTaskMetadata('prompt body');
    expect(meta.suggestedPriority).toBe('medium');
  });

  it('validates priority field and defaults invalid values to medium', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue(
      JSON.stringify({ title: 't', description: 'd', suggestedPriority: 'critical' })
    );
    const meta = await generateTaskMetadata('x');
    expect(meta.suggestedPriority).toBe('medium');
  });
});

describe('ai — generatePullRequestContent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the fallback when no daemon is available', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue(null);
    const out = await generatePullRequestContent({
      taskTitle: 'Fix stuff',
      prompt: 'please fix',
    });
    expect(out.title).toBe('Fix stuff');
    // Fallback body quotes the prompt.
    expect(out.body).toContain('> please fix');
  });

  it('parses a JSON response with title + body', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue(
      JSON.stringify({ title: 'feat: add login', body: 'Wires Supabase OAuth.' })
    );
    const out = await generatePullRequestContent({ taskTitle: 'fallback-title' });
    expect(out.title).toBe('feat: add login');
    expect(out.body).toContain('Supabase');
  });

  it('includes the template content in the prompt when provided', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    const run = vi
      .spyOn(claudeCli, 'runClaudeCli')
      .mockResolvedValue(JSON.stringify({ title: 'feat: x', body: 'y' }));

    await generatePullRequestContent({
      taskTitle: 't',
      templateContent: '## Why\n<!-- fill -->',
    });
    const [, prompt] = run.mock.calls[0];
    expect(prompt).toContain('## Why');
    expect(prompt).toContain('PR TEMPLATE');
  });

  it('falls back on malformed JSON', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue('not json');
    const out = await generatePullRequestContent({
      taskTitle: 'My task',
      prompt: 'the prompt',
    });
    expect(out.title).toBe('My task');
    expect(out.body).toContain('> the prompt');
  });

  it('truncates a huge diff down to ~6000 chars before sending', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    const run = vi
      .spyOn(claudeCli, 'runClaudeCli')
      .mockResolvedValue(JSON.stringify({ title: 't', body: 'b' }));

    const hugeDiff = 'a'.repeat(30_000);
    await generatePullRequestContent({ taskTitle: 't', diff: hugeDiff });
    const [, prompt] = run.mock.calls[0];
    expect(prompt).toContain('diff truncated');
    // Prompt should be much smaller than the raw diff.
    expect(prompt.length).toBeLessThan(15_000);
  });
});

describe('ai — generateCommitMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the title as fallback when no daemon is available', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue(null);
    expect(
      await generateCommitMessage({ title: 'Add feature x' })
    ).toBe('Add feature x');
  });

  it('returns the Claude output on success', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue(
      'feat(auth): add login endpoint\n\nWires the GitHub OAuth callback.'
    );
    const msg = await generateCommitMessage({ title: 'Add login', diff: '+hi\n' });
    expect(msg).toMatch(/^feat\(auth\)/);
    expect(msg).toContain('Wires the GitHub OAuth callback');
  });

  it('strips markdown fences the model might add', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue(
      '```\nfeat: add thing\n```'
    );
    const msg = await generateCommitMessage({ title: 'x' });
    expect(msg).toBe('feat: add thing');
  });

  it('echo guard: falls back when Claude just returns the user prompt', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue(
      'please add a login flow'
    );
    const msg = await generateCommitMessage({
      title: 'Login',
      prompt: 'Please add a login flow',
    });
    expect(msg).toBe('Login');
  });

  it('falls back on an empty model response', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockResolvedValue('   ');
    expect(await generateCommitMessage({ title: 'T' })).toBe('T');
  });

  it('falls back on runClaudeCli throw', async () => {
    vi.spyOn(claudeCli, 'pickGenerationEnv').mockReturnValue('env-1');
    vi.spyOn(claudeCli, 'runClaudeCli').mockRejectedValue(new Error('claude missing'));
    expect(await generateCommitMessage({ title: 'T' })).toBe('T');
  });
});
