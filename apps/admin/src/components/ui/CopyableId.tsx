import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * A truncated monospace id with a copy button.
 *
 * Operators paste ids constantly — into Slack, into a `fleetctl` command, into
 * a search box on another page. Truncation keeps a table readable; the copy
 * button means truncation never costs anything, because selecting a
 * middle-elided string by hand does not work.
 */
export function CopyableId({
  value,
  display,
  className,
}: {
  value: string | null | undefined;
  /** What to show. Defaults to the value, truncated by CSS. */
  display?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  if (!value) return <span className="text-muted-foreground">—</span>;

  async function copy(e: React.MouseEvent) {
    // Rows are often clickable; copying an id should not also navigate.
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value!);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard needs a secure context and permission. Failing silently is
      // right: the id is still on screen and selectable.
    }
  }

  return (
    <span className={cn('group inline-flex max-w-full items-center gap-1', className)}>
      <span className="truncate font-mono text-xs" title={value}>
        {display ?? value}
      </span>
      <button
        onClick={copy}
        aria-label={copied ? 'Copied' : `Copy ${value}`}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}
