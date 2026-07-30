/** Helpers for copying PR links to the clipboard as Markdown + rich HTML, so a
 *  paste into Slack/GitHub/docs lands as a clickable link. Shared by the
 *  per-row "copy link" button and the "Copy list" header action. */

/** Escape a string for safe interpolation into copied HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Write a rich (`text/html`) + plain (`text/plain`) pair to the clipboard,
 * falling back to plain text where `ClipboardItem` isn't available.
 */
export async function copyRich(html: string, text: string): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
  } else {
    await navigator.clipboard.writeText(text);
  }
}

/** Markdown + rich-HTML for a single PR link: `[title](url)` / `<a href>title</a>`. */
export function prMarkdownLink(title: string, url: string): { markdown: string; html: string } {
  const t = title || '(no title)';
  return {
    markdown: `[${t}](${url})`,
    html: `<a href="${escapeHtml(url)}">${escapeHtml(t)}</a>`,
  };
}
