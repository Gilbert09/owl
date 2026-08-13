import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { Markdown } from '../lib/markdown';

/**
 * ```mermaid fences in a PR body render as diagrams, the way they do on
 * GitHub. This is the full pipeline — react-markdown, remark-gfm, rehype-raw,
 * rehype-sanitize — with only mermaid itself stubbed, because its renderer
 * needs SVG measurement APIs (getBBox and friends) that jsdom does not
 * implement.
 *
 * The security assertion here is the load-bearing one. Mermaid's SVG is
 * injected with `dangerouslySetInnerHTML`, so it bypasses the `rehypeSanitize`
 * pass that `markdownSanitize.test.tsx` pins. `securityLevel: 'strict'` is what
 * takes its place: mermaid runs its own DOMPurify over the output and disables
 * HTML labels and `click` directives. If that assertion fails, the fix is to
 * restore the setting — not to update the expectation.
 */

const calls: { initialize: Record<string, unknown>[]; render: string[] } = {
  initialize: [],
  render: [],
};

vi.mock('mermaid', () => ({
  default: {
    initialize: (config: Record<string, unknown>) => {
      calls.initialize.push(config);
    },
    render: async (id: string, code: string) => {
      calls.render.push(code);
      return { svg: `<svg data-stub-mermaid="${id}"><title>diagram</title></svg>` };
    },
  },
}));

// `globals: false` in vitest.config.ts means testing-library never registers
// its own afterEach — without this, trees from earlier tests stay mounted and
// their pending mermaid renders land in the next test's `calls`.
afterEach(cleanup);

beforeEach(() => {
  calls.initialize.length = 0;
  calls.render.length = 0;
  document.documentElement.classList.remove('dark');
});

const BODY = [
  '## Summary',
  '',
  '```mermaid',
  'graph TD;',
  '  A[Client] --> B[Backend];',
  '```',
  '',
  'Trailing prose.',
].join('\n');

describe('Mermaid in markdown', () => {
  it('renders a mermaid fence as a diagram, not a code block', async () => {
    const { container } = render(<Markdown text={BODY} variant="surface" />);

    await waitFor(() =>
      expect(container.querySelector('[data-mermaid-diagram]')).not.toBeNull()
    );
    expect(container.querySelector('svg[data-stub-mermaid]')).not.toBeNull();
    // The surrounding markdown still renders, and the source is not left
    // sitting in a <pre> next to the picture.
    expect(container.textContent).toContain('Trailing prose');
    expect(container.querySelector('pre')).toBeNull();
    expect(calls.render[0]).toBe('graph TD;\n  A[Client] --> B[Backend];');
  });

  it('leaves other fenced languages as code blocks', async () => {
    const { container } = render(
      <Markdown text={'```ts\nconst a: number = 1;\n```'} variant="surface" />
    );

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('const a: number = 1;');
    expect(container.querySelector('[data-mermaid-diagram]')).toBeNull();
    expect(calls.render).toHaveLength(0);
  });

  it('initialises mermaid with securityLevel strict', async () => {
    render(<Markdown text={BODY} variant="surface" />);

    await waitFor(() => expect(calls.initialize.length).toBeGreaterThan(0));
    expect(calls.initialize[0].securityLevel).toBe('strict');
    expect(calls.initialize[0].suppressErrorRendering).toBe(true);
    expect(calls.initialize[0].startOnLoad).toBe(false);
  });

  it('follows the app theme', async () => {
    document.documentElement.classList.add('dark');
    render(<Markdown text={BODY} variant="surface" />);

    await waitFor(() => expect(calls.initialize.length).toBeGreaterThan(0));
    expect(calls.initialize[0].theme).toBe('dark');
  });

  it('renders more than one diagram in the same body', async () => {
    const two = ['```mermaid', 'graph TD; A-->B;', '```', '', '```mermaid', 'graph TD; C-->D;', '```'].join(
      '\n'
    );
    const { container } = render(<Markdown text={two} variant="surface" />);

    await waitFor(() =>
      expect(container.querySelectorAll('[data-mermaid-diagram]')).toHaveLength(2)
    );
    expect(calls.render).toEqual(['graph TD; A-->B;', 'graph TD; C-->D;']);
  });
});
