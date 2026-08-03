/**
 * jsdom gaps that real browsers provide.
 *
 * Stubbed rather than mocked per-test: this is environment, not behaviour
 * under test.
 */
// `crypto.randomUUID` exists in every browser we target, but only in a SECURE
// CONTEXT — https, or localhost. Both the deployed console and local dev
// qualify, so this is purely a jsdom gap. It matters here specifically:
// ConfirmMutationDialog mints one per dialog open as an idempotency key, so a
// double-click cannot fire a mutation twice.
if (!globalThis.crypto?.randomUUID) {
  const uuid = () =>
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
      (
        Number(c) ^
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))
      ).toString(16)
    );
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: uuid });
}

// Touched by anything that follows the system colour scheme.
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
