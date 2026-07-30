import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { cn } from './utils';

/**
 * Markdown renderer for both the agent transcript feed and the
 * theme-adaptive panels (PR detail, etc.). Backed by react-markdown +
 * remark-gfm (tables, task lists, strikethrough, autolinks) and
 * rehype-raw → rehype-sanitize so raw HTML common in PR/review bodies
 * (e.g. collapsible `<details>` sections) renders safely.
 *
 * Two variants because the colour palette differs by surface:
 *   - `feed`    — the always-dark agent transcript (bg #1a1a1a).
 *   - `surface` — theme-adaptive panels like the PR detail sheet.
 */
export type MarkdownVariant = 'feed' | 'surface';

interface MdClasses {
  heading: string;
  fence: string;
  inlineCode: string;
  link: string;
  blockquote: string;
  hr: string;
  border: string;
}

const FEED: MdClasses = {
  heading: 'text-zinc-100',
  fence: 'bg-black/40',
  inlineCode: 'bg-white/10',
  link: 'text-blue-400 hover:text-blue-300',
  blockquote: 'border-zinc-600 text-zinc-300',
  hr: 'border-zinc-700/60',
  border: 'border-zinc-700/60',
};

const SURFACE: MdClasses = {
  heading: 'text-foreground',
  fence: 'bg-muted text-foreground',
  inlineCode: 'bg-muted',
  link: 'text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300',
  blockquote: 'border-border text-muted-foreground',
  hr: 'border-border',
  border: 'border-border',
};

// Allow GitHub's collapsible <details>/<summary> through the sanitizer
// (the default schema is otherwise GitHub-equivalent — task-list inputs,
// tables, etc. are already permitted).
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: Array.from(
    new Set([...(defaultSchema.tagNames ?? []), 'details', 'summary'])
  ),
  attributes: {
    ...defaultSchema.attributes,
    details: [...((defaultSchema.attributes?.details as string[]) ?? []), 'open'],
  },
};

const REMARK_PLUGINS = [remarkGfm];
// rehype-raw must run before sanitize: it turns raw HTML strings into
// hast nodes, which sanitize then prunes against the schema.
const REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]] as const;

function makeComponents(c: MdClasses): Components {
  return {
    p: ({ children }) => (
      <p className="my-1 leading-relaxed [overflow-wrap:anywhere]">{children}</p>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn('underline underline-offset-2 [overflow-wrap:anywhere]', c.link)}
      >
        {children}
      </a>
    ),
    h1: ({ children }) => (
      <div className={cn('mt-2 mb-1 text-base font-semibold', c.heading)}>{children}</div>
    ),
    h2: ({ children }) => (
      <div className={cn('mt-2 mb-1 text-sm font-semibold', c.heading)}>{children}</div>
    ),
    h3: ({ children }) => (
      <div className={cn('mt-2 mb-1 text-sm font-medium', c.heading)}>{children}</div>
    ),
    h4: ({ children }) => (
      <div className={cn('mt-2 mb-1 text-sm font-medium', c.heading)}>{children}</div>
    ),
    h5: ({ children }) => (
      <div className={cn('mt-2 mb-1 text-sm font-medium', c.heading)}>{children}</div>
    ),
    h6: ({ children }) => (
      <div className={cn('mt-2 mb-1 text-sm font-medium', c.heading)}>{children}</div>
    ),
    ul: ({ children }) => <ul className="my-1 ml-5 list-disc space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1 ml-5 list-decimal space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="[overflow-wrap:anywhere]">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote
        className={cn('my-1 border-l-2 pl-3 [overflow-wrap:anywhere]', c.blockquote)}
      >
        {children}
      </blockquote>
    ),
    hr: () => <hr className={cn('my-2', c.hr)} />,
    pre: ({ children }) => (
      <pre
        className={cn(
          'my-1 max-w-full overflow-x-auto whitespace-pre-wrap rounded p-2 font-mono text-xs [overflow-wrap:anywhere]',
          c.fence
        )}
      >
        {children}
      </pre>
    ),
    code: ({ className, children }) => {
      // Fenced blocks carry a `language-*` class and live inside <pre>
      // (styled above) — render them plain so they don't get the inline
      // pill. Everything else is inline code.
      const isBlock = /language-/.test(className ?? '');
      if (isBlock) {
        return <code className="font-mono">{children}</code>;
      }
      return (
        <code
          className={cn('rounded px-1 font-mono text-xs [overflow-wrap:anywhere]', c.inlineCode)}
        >
          {children}
        </code>
      );
    },
    table: ({ children }) => (
      <div className="my-1 overflow-x-auto">
        <table className={cn('w-full border-collapse text-xs', c.heading)}>{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className={cn('border px-2 py-1 text-left font-semibold', c.border)}>{children}</th>
    ),
    td: ({ children }) => (
      <td className={cn('border px-2 py-1 align-top', c.border)}>{children}</td>
    ),
    details: ({ children }) => (
      <details className={cn('my-1 rounded border px-3 py-2 [overflow-wrap:anywhere]', c.border)}>
        {children}
      </details>
    ),
    summary: ({ children }) => (
      <summary className={cn('cursor-pointer font-medium', c.heading)}>{children}</summary>
    ),
    img: ({ src, alt }) => (
      <img src={typeof src === 'string' ? src : undefined} alt={alt} className="max-w-full rounded" />
    ),
  };
}

const FEED_COMPONENTS = makeComponents(FEED);
const SURFACE_COMPONENTS = makeComponents(SURFACE);

export function Markdown({
  text,
  variant = 'feed',
}: {
  text: string;
  variant?: MarkdownVariant;
}): React.ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      // Cast: the tuple-with-options plugin form is valid at runtime but
      // widens awkwardly against PluggableList.
      rehypePlugins={REHYPE_PLUGINS as never}
      components={variant === 'surface' ? SURFACE_COMPONENTS : FEED_COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
}

/**
 * Backwards-compatible helper kept so existing call sites read the same.
 * Prefer `<Markdown … />` in new code.
 */
export function renderMarkdownish(
  text: string,
  variant: MarkdownVariant = 'feed'
): React.ReactNode {
  return <Markdown text={text} variant={variant} />;
}
