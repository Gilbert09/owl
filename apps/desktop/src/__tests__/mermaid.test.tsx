import '@testing-library/jest-dom';
import React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { MermaidDiagram, mermaidSourceFromPre } from '../renderer/lib/mermaid';

// mermaid itself is stubbed (.erb/mocks/mermaidMock.js): it is ESM, and its
// real renderer needs SVG measurement APIs jsdom does not implement. What is
// worth pinning here is our wiring — which fences become diagrams, what config
// mermaid is initialised with, and what the user sees when a diagram fails.
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const mermaidStub = require('mermaid') as {
  default: {
    initialize: (config: unknown) => void;
    render: (id: string, code: string) => Promise<{ svg: string }>;
  };
  __calls: { initialize: Record<string, unknown>[]; render: { id: string; code: string }[] };
};

const CLASSES = { fence: 'fence', border: 'border', muted: 'muted' };

function codeEl(className: string | undefined, text: string) {
  return React.createElement('code', { className }, text);
}

beforeEach(() => {
  mermaidStub.__calls.initialize.length = 0;
  mermaidStub.__calls.render.length = 0;
  document.documentElement.classList.remove('dark');
});

describe('mermaidSourceFromPre', () => {
  it('extracts the source of a language-mermaid fence', () => {
    expect(mermaidSourceFromPre(codeEl('language-mermaid', 'graph TD;\n A-->B;\n'))).toBe(
      'graph TD;\n A-->B;'
    );
  });

  it('matches language-mermaid alongside other classes', () => {
    expect(mermaidSourceFromPre(codeEl('hljs language-mermaid extra', 'graph TD;'))).toBe(
      'graph TD;'
    );
  });

  it.each([
    ['another language', 'language-ts', 'const a = 1;'],
    ['a language whose name merely starts the same way', 'language-mermaidish', 'x'],
    ['a language whose name merely ends the same way', 'language-notmermaid', 'x'],
    ['no language at all', undefined, 'plain'],
  ])('returns null for %s', (_label, className, text) => {
    expect(mermaidSourceFromPre(codeEl(className, text))).toBeNull();
  });

  it('returns null for an empty mermaid fence rather than rendering nothing', () => {
    expect(mermaidSourceFromPre(codeEl('language-mermaid', '   \n  '))).toBeNull();
  });

  it('returns null when the child is not an element', () => {
    expect(mermaidSourceFromPre('bare text')).toBeNull();
  });
});

describe('MermaidDiagram', () => {
  it('renders the SVG mermaid produces', async () => {
    const { container, getByText } = render(
      <MermaidDiagram code="graph TD; A-->B;" classes={CLASSES} />
    );

    // Nothing is injected until the (dynamically imported) renderer answers.
    expect(getByText('Rendering diagram…')).toBeInTheDocument();

    await waitFor(() =>
      expect(container.querySelector('[data-mermaid-diagram]')).toBeInTheDocument()
    );
    expect(container.querySelector('svg[data-stub-mermaid]')).toBeInTheDocument();
    expect(mermaidStub.__calls.render[0].code).toBe('graph TD; A-->B;');
  });

  it('renders with securityLevel strict, which is what makes the SVG safe to inject', async () => {
    render(<MermaidDiagram code="graph TD; A-->B;" classes={CLASSES} />);
    await waitFor(() => expect(mermaidStub.__calls.initialize.length).toBeGreaterThan(0));

    const config = mermaidStub.__calls.initialize[0];
    expect(config.securityLevel).toBe('strict');
    expect(config.startOnLoad).toBe(false);
    // Otherwise a parse failure appends mermaid's own error SVG to <body>.
    expect(config.suppressErrorRendering).toBe(true);
  });

  it('shows the source and the reason when the diagram cannot be rendered', async () => {
    const spy = jest
      .spyOn(mermaidStub.default, 'render')
      .mockRejectedValueOnce(new Error('Parse error on line 2'));

    const { getByText } = render(<MermaidDiagram code="graph TD; ???" classes={CLASSES} />);

    await waitFor(() =>
      expect(getByText(/Could not render this Mermaid diagram/)).toBeInTheDocument()
    );
    expect(getByText('graph TD; ???')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('uses the dark mermaid theme when the app is in dark mode', async () => {
    document.documentElement.classList.add('dark');
    render(<MermaidDiagram code="graph TD; A-->B;" classes={CLASSES} />);
    await waitFor(() => expect(mermaidStub.__calls.initialize.length).toBeGreaterThan(0));
    expect(mermaidStub.__calls.initialize[0].theme).toBe('dark');
  });

  it('re-renders with the dark theme when the app theme flips', async () => {
    render(<MermaidDiagram code="graph TD; A-->B;" classes={CLASSES} />);
    await waitFor(() => expect(mermaidStub.__calls.render.length).toBe(1));
    expect(mermaidStub.__calls.initialize[0].theme).toBe('default');

    await act(async () => {
      document.documentElement.classList.add('dark');
    });

    await waitFor(() => expect(mermaidStub.__calls.render.length).toBe(2));
    expect(mermaidStub.__calls.initialize[1].theme).toBe('dark');
  });

  it('stays dark in the always-dark agent feed, whatever the app theme is', async () => {
    render(<MermaidDiagram code="graph TD; A-->B;" classes={CLASSES} forceDark />);
    await waitFor(() => expect(mermaidStub.__calls.initialize.length).toBeGreaterThan(0));
    expect(mermaidStub.__calls.initialize[0].theme).toBe('dark');
  });

  it('gives each diagram a DOM-legal, unique id', async () => {
    render(
      <>
        <MermaidDiagram code="graph TD; A-->B;" classes={CLASSES} />
        <MermaidDiagram code="graph TD; C-->D;" classes={CLASSES} />
      </>
    );

    await waitFor(() => expect(mermaidStub.__calls.render.length).toBe(2));
    const [first, second] = mermaidStub.__calls.render.map((c) => c.id);
    expect(first).not.toBe(second);
    for (const id of [first, second]) {
      expect(id).toMatch(/^talyn-mermaid-[a-zA-Z0-9]*$/);
    }
  });
});
