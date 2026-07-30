/**
 * jsdom gaps that real browsers provide.
 *
 * `matchMedia` is used at module scope by stores/workspace.ts to follow the
 * system colour scheme, so importing anything that touches the store throws
 * without this. Stubbed rather than mocked per-test: it is environment, not
 * behaviour under test.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
