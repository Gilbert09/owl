import { describe, expect, it } from 'vitest';
import {
  GENERIC_PROVIDER_LOGO,
  SELFHOSTED_LOGO,
  POSTHOG_LOGO,
  CODEX_LOGO,
} from '../assets/providers/logos';

/**
 * The provider marks are real images.
 *
 * The bug this exists for: both inline-SVG marks — the Talyn Fleet rack and the
 * unknown-provider cloud — wrote their colour as `stroke="%23888"`, hand-escaping
 * the hash for the data URI. `encodeURIComponent` then escaped the PERCENT, so
 * the stored URI carried `%2523`, the browser decoded it back to the literal
 * text `%23888`, and SVG rejected that as a colour. An invalid presentation
 * attribute falls back to its initial value, which for `stroke` is `none`.
 *
 * The result was an `<img>` of exactly the right size containing nothing at all.
 * It reported as "fleet tasks have no icon", which is indistinguishable from
 * never having drawn one — no console error, no broken-image glyph, no failing
 * test. That is why the assertion here is on the DECODED payload rather than on
 * the source: the source looked correct, and was.
 */

const SVG_PREFIX = 'data:image/svg+xml;utf8,';

function decodeSvg(dataUri: string): string {
  expect(dataUri.startsWith(SVG_PREFIX)).toBe(true);
  return decodeURIComponent(dataUri.slice(SVG_PREFIX.length));
}

/** Hex colours, the only form these marks use. Anything else is the bug. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

describe('inline SVG provider marks', () => {
  const marks: Array<[string, string]> = [
    ['Talyn Fleet', SELFHOSTED_LOGO],
    ['unknown provider', GENERIC_PROVIDER_LOGO],
  ];

  it('Talyn Fleet is the owl, not the server rack it replaced', () => {
    // Geometry, not a name: the mark is duplicated between here, TalynMark.tsx
    // and apps/marketing, and nothing at build time notices if they drift. The
    // head dome is the one path that is unmistakably the bird.
    const svg = decodeSvg(SELFHOSTED_LOGO);
    expect(svg).toContain('M18 22 C 21 10 43 10 46 22');
    expect(svg).not.toContain('<rect');
  });

  it.each(marks)('%s decodes to a well-formed <svg>', (_name, uri) => {
    const svg = decodeSvg(uri);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it.each(marks)('%s paints with a colour a browser will accept', (_name, uri) => {
    const svg = decodeSvg(uri);
    const strokes = [...svg.matchAll(/stroke="([^"]*)"/g)].map((m) => m[1]);
    expect(strokes.length).toBeGreaterThan(0);

    for (const value of strokes) {
      // `none` is legitimate on a child that is fill-only; the paint that
      // matters is that at least one is a real colour, asserted below.
      if (value === 'none') continue;
      expect(value).toMatch(HEX);
    }
    expect(strokes.some((v) => HEX.test(v))).toBe(true);
  });

  it.each(marks)('%s survives decoding without a stray percent escape', (_name, uri) => {
    // The precise failure: `%23` in the source becomes `%2523` in the URI and
    // decodes back to text, not to `#`. If a `%` reaches the decoded SVG at
    // all, something was escaped twice.
    expect(decodeSvg(uri)).not.toContain('%');
  });

  it.each(marks)('%s draws something — geometry, not just a viewBox', (_name, uri) => {
    const svg = decodeSvg(uri);
    expect(svg).toMatch(/<(path|rect|circle|line|polygon|polyline)\b/);
  });
});

describe('raster provider marks', () => {
  it.each([
    ['PostHog', POSTHOG_LOGO],
    ['Codex', CODEX_LOGO],
  ])('%s is a non-empty inline PNG', (_name, uri) => {
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    // A truncated data URI still "starts with" the prefix and still renders
    // nothing, so assert there is a real payload behind it.
    expect(uri.length).toBeGreaterThan(512);
  });
});

describe('every mark is distinct', () => {
  it('no two providers share an image', () => {
    const all = [POSTHOG_LOGO, CODEX_LOGO, SELFHOSTED_LOGO, GENERIC_PROVIDER_LOGO];
    // A copy-paste that points two providers at one mark makes the badge lie
    // about which agent ran a task, which is worse than having no badge.
    expect(new Set(all).size).toBe(all.length);
  });
});
