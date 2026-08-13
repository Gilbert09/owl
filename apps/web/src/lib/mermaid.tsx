import React from 'react';
import { cn } from './utils';

/**
 * Renders a ```mermaid fenced block as a diagram, the way GitHub does.
 *
 * Two things this file is careful about:
 *
 * 1. **Weight.** mermaid is megabytes of JavaScript and most PR bodies hold no
 *    diagram at all, so it is imported dynamically the first time one appears
 *    and the module promise is cached from then on.
 *
 * 2. **Trust.** Diagram source is untrusted — anyone who can open a PR against
 *    a watched repo controls the string. The SVG mermaid produces is injected
 *    with `dangerouslySetInnerHTML`, which walks straight past the
 *    `rehypeSanitize` pass in `markdown.tsx`. `securityLevel: 'strict'` is what
 *    replaces it: it runs mermaid's own DOMPurify pass over the output and
 *    turns OFF both HTML labels and `click` directives — the two routes from
 *    diagram source to arbitrary markup. mermaid's `secure` list protects
 *    `securityLevel` from being overridden by a `%%{init: …}%%` directive
 *    inside the source, so the setting cannot be undone by the input itself.
 *    Do not relax it to `loose`/`antiscript` to make a diagram look nicer.
 */

type MermaidApi = typeof import('mermaid').default;

let cached: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!cached) {
    cached = import('mermaid').then((mod) => mod.default);
  }
  return cached;
}

export interface MermaidClasses {
  fence: string;
  border: string;
  muted: string;
}

/**
 * Tracks the app theme so a diagram re-renders when it flips. The theme is a
 * `dark` class on <html> (see the workspace store), not a media query, so the
 * class attribute is what to watch.
 */
function useIsDark(force: boolean): boolean {
  const read = () =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const [dark, setDark] = React.useState(read);

  React.useEffect(() => {
    if (force) return undefined;
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [force]);

  return force || dark;
}

export function MermaidDiagram({
  code,
  classes,
  forceDark = false,
}: {
  code: string;
  classes: MermaidClasses;
  /** The agent feed is always dark, whatever the app theme is. */
  forceDark?: boolean;
}): React.ReactElement {
  const isDark = useIsDark(forceDark);
  const [svg, setSvg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // mermaid renders into a DOM node it keys off this id, so it has to be
  // unique per diagram and a valid id — React 19's useId is neither of those
  // on its own (it wraps the value in non-alphanumeric delimiters).
  const id = `talyn-mermaid-${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  React.useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          // Without this, a parse failure makes mermaid append its own "Syntax
          // error" bomb SVG to <body> — outside React's tree, so nothing ever
          // cleans it up. We show the source instead.
          suppressErrorRendering: true,
          theme: isDark ? 'dark' : 'default',
        });
        const { svg: out } = await mermaid.render(id, code);
        if (!cancelled) setSvg(out);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        // A throw part-way through render can leave mermaid's scratch node
        // parented to <body>.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      });

    return () => {
      cancelled = true;
    };
  }, [code, id, isDark]);

  if (error !== null) {
    // Never swallow it: show why the diagram is missing, and the source, so the
    // body still reads the way it does on GitHub minus the picture.
    return (
      <div className={cn('my-1 rounded border p-2', classes.border)}>
        <p className={cn('mb-1 text-xs', classes.muted)}>
          Could not render this Mermaid diagram: {error}
        </p>
        <pre
          className={cn(
            'max-w-full overflow-x-auto whitespace-pre-wrap rounded p-2 font-mono text-xs [overflow-wrap:anywhere]',
            classes.fence
          )}
        >
          <code className="font-mono">{code}</code>
        </pre>
      </div>
    );
  }

  if (svg === null) {
    return (
      <p className={cn('my-1 text-xs', classes.muted)} data-mermaid-pending="true">
        Rendering diagram…
      </p>
    );
  }

  return (
    <div
      className="my-2 max-w-full overflow-x-auto [&_svg]:max-w-full"
      data-mermaid-diagram="true"
      // Safe only because of `securityLevel: 'strict'` above — see the file header.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * Pulls the source out of react-markdown's `<pre><code class="language-mermaid">`
 * pair, or returns null when the block is anything else.
 *
 * Lives here rather than inline in `markdown.tsx` so it can be tested without
 * booting the whole markdown pipeline.
 */
export function mermaidSourceFromPre(children: React.ReactNode): string | null {
  const [child] = React.Children.toArray(children);
  if (!React.isValidElement(child)) return null;

  const props = child.props as { className?: string; children?: React.ReactNode };
  if (!/(^|\s)language-mermaid(\s|$)/.test(props.className ?? '')) return null;

  const source = React.Children.toArray(props.children)
    .filter((node): node is string => typeof node === 'string')
    .join('')
    .trim();

  return source === '' ? null : source;
}
