// Provider brand logos (logo.dev), inlined as base64 data URIs so they
// resolve regardless of bundler/asset-URL handling in the packaged app.
// PostHog → posthog.com, Codex → openai.com (deferred).
export const POSTHOG_LOGO = 'data:image/png;base64,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';
export const CODEX_LOGO = 'data:image/png;base64,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';

/**
 * Fallback mark for a provider this build has no logo for — a provider added by
 * a newer backend than this (released, long-lived) client. A neutral outlined
 * cloud, so an unknown provider reads as "some cloud agent" rather than as a
 * broken image or, worse, as nothing at all. Inline SVG: no new asset, no
 * network fetch, and it inherits nothing so it looks the same in both themes.
 *
 * Colours are written as plain `#rrggbb` and escaped ONCE, by
 * encodeURIComponent. Pre-escaping the hash as `%23` looks right and is not:
 * encodeURIComponent then escapes the percent, the browser decodes `%2523`
 * back to the literal text `%23888`, SVG rejects that as a colour, and an
 * invalid presentation attribute falls back to `stroke: none` — a perfectly
 * sized, perfectly invisible icon. Both SVG marks here shipped that way and
 * read as "there is no icon". See logos.test.ts.
 */
export const GENERIC_PROVIDER_LOGO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#888" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 6.5 19z"/>' +
      '</svg>',
  );

/**
 * Talyn Fleet, as a URL.
 *
 * The owl, not the server rack it replaced: a rack says "self-hosted", which is
 * a deployment detail, where the brand says whose fleet it is.
 *
 * This is the FALLBACK form. `ProviderIcon` renders {@link TalynOwlMark}
 * instead, because a data URI cannot inherit `currentColor` and this mark has
 * to follow the theme — black on light, legible on dark. The ink here is fixed
 * for the same reason it is fixed on every other provider's logo: an `<img>`
 * has no way to ask. Keep the geometry in step with TalynMark.tsx.
 */
export const SELFHOSTED_LOGO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" ' +
      'stroke="#1c1917" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M18 22 C 21 10 43 10 46 22"/>' +
      '<path d="M16 25 C 11 33 11 46 18 53"/>' +
      '<path d="M48 25 C 53 33 53 46 46 53"/>' +
      '<circle cx="25.5" cy="30" r="4.4"/>' +
      '<circle cx="38.5" cy="30" r="4.4"/>' +
      '<path d="M29 37 L 32 43 L 35 37"/>' +
      '<path d="M27 49 Q 32 52 37 49"/>' +
      '</svg>',
  );
