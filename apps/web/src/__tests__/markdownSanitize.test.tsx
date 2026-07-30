import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../lib/markdown';

/**
 * The markdown sanitiser, pinned.
 *
 * This is the app's largest untrusted-input surface: PR titles and bodies,
 * review comments, and agent transcripts are all attacker-influenceable (open
 * a PR against a watched repo and you control the string). It renders raw HTML
 * on purpose — `rehypeRaw` — so the ONLY thing standing between that and
 * script execution is `rehypeSanitize` running after it against a pinned
 * schema.
 *
 * On the desktop a slip here was contained: the renderer runs with
 * contextIsolation and cannot reach the session, which lives in main-process
 * safeStorage. In the browser the Supabase session is in localStorage, so the
 * same slip is a refresh-token exfiltration and a durable account takeover.
 * Same code, much larger blast radius — hence tests here that the desktop
 * never had.
 *
 * If one of these fails, do not "fix" it by loosening the schema.
 */

/**
 * Render and return the HTML.
 *
 * The sentinels are load-bearing. Every assertion below is a NEGATIVE one
 * ("does not contain <script>"), and those pass trivially against an empty
 * string — which is exactly what happened when this helper first passed the
 * markdown as `children` instead of `text`: the component rendered nothing
 * and 17 security assertions "passed" while testing absolutely nothing.
 * Asserting the sentinels survived proves the pipeline actually ran.
 */
function html(markdown: string): string {
  const { container } = render(
    <Markdown text={`SENTINELSTART\n\n${markdown}\n\nSENTINELEND`} />
  );
  const out = container.innerHTML;
  expect(out).toContain('SENTINELSTART');
  expect(out).toContain('SENTINELEND');
  return out;
}

describe('script execution vectors are stripped', () => {
  it.each([
    ['script tag', '<script>alert(1)</script>'],
    ['img onerror', '<img src=x onerror="alert(1)">'],
    ['svg onload', '<svg onload="alert(1)"></svg>'],
    ['body onload', '<body onload="alert(1)">'],
    ['iframe', '<iframe src="https://evil.example.com"></iframe>'],
    ['object', '<object data="evil.swf"></object>'],
    ['embed', '<embed src="evil.swf">'],
    ['inline handler on a div', '<div onclick="alert(1)">click</div>'],
    ['form with action', '<form action="https://evil.example.com"><input name="x"></form>'],
    ['style tag', '<style>body{display:none}</style>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example.com">'],
    ['base tag', '<base href="https://evil.example.com/">'],
  ])('%s', (_label, markdown) => {
    const out = html(markdown);
    expect(out).not.toMatch(/<script|<iframe|<object|<embed|<style|<meta|<base|<form/i);
    // No inline event handler of any kind survives.
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).not.toContain('alert(1)');
  });
});

describe('dangerous URL protocols are stripped', () => {
  it.each([
    ['javascript: href', '[click](javascript:alert(1))'],
    ['JaVaScRiPt: mixed case', '[click](JaVaScRiPt:alert(1))'],
    ['data: html href', '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['vbscript: href', '[click](vbscript:msgbox(1))'],
    ['raw anchor with javascript:', '<a href="javascript:alert(1)">click</a>'],
  ])('%s', (_label, markdown) => {
    const out = html(markdown);
    expect(out.toLowerCase()).not.toContain('javascript:');
    expect(out.toLowerCase()).not.toContain('vbscript:');
    expect(out).not.toContain('alert(1)');
  });
});

describe('what must keep working', () => {
  it('renders ordinary formatting', () => {
    const out = html('**bold** and `code` and a [link](https://example.com)');
    expect(out).toContain('<strong>');
    expect(out).toContain('<code');
    expect(out).toContain('https://example.com');
  });

  it('opens links in a new tab with rel="noopener noreferrer"', () => {
    // Without noopener the opened page gets window.opener and can navigate
    // this tab somewhere that looks like Talyn and asks for a login.
    const out = html('[link](https://example.com)');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('keeps GitHub collapsible sections — the reason the schema is extended', () => {
    const out = html('<details open><summary>More</summary>hidden text</details>');
    expect(out).toContain('<details');
    expect(out).toContain('<summary');
    expect(out).toContain('hidden text');
  });

  it('renders GFM tables and task lists', () => {
    expect(html('| a | b |\n| - | - |\n| 1 | 2 |')).toContain('<table');
    expect(html('- [x] done\n- [ ] todo')).toContain('type="checkbox"');
  });
});
