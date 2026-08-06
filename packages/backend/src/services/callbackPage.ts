/**
 * The landing page an OAuth callback renders when there is nowhere to send the
 * user.
 *
 * The desktop app opens these flows in the system browser, so at the end of one
 * the user is sitting on the API origin with no app around them — they need
 * *something* to look at before closing the tab (the app re-polls the relevant
 * status on focus, so no deep link is needed). The browser app is a different
 * case: it is in THIS tab, so its flows redirect back into the app instead and
 * never reach here.
 *
 * Shared by the GitHub App and PostHog OAuth callbacks so the two can't drift
 * into two different-looking pages.
 */
export function renderCallbackPage(opts: {
  ok: boolean;
  /** What connected, e.g. 'GitHub' / 'PostHog'. Used in the heading. */
  product: string;
  message: string;
}): string {
  const color = opts.ok ? '#16a34a' : '#dc2626';
  const title = opts.ok ? `${opts.product} connected` : 'Connection failed';
  const safe = escapeHtml(opts.message);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Talyn — ${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #0b0b0f; color: #e5e7eb; display: grid; place-items: center;
           min-height: 100vh; margin: 0; }
    .card { background: #16161d; border: 1px solid #27272f; border-radius: 12px;
            padding: 32px 40px; max-width: 420px; text-align: center; }
    h1 { margin: 0 0 8px 0; font-size: 20px; color: ${color}; }
    p { margin: 0; color: #9ca3af; font-size: 14px; line-height: 1.5; }
    .hint { margin-top: 18px; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${safe}</p>
    <p class="hint">You can close this tab and return to Talyn.</p>
  </div>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
