// Jest setup file. Polyfills TextEncoder/TextDecoder for JSDOM so React
// Testing Library can run without a pre-built bundle.
import { TextEncoder, TextDecoder } from 'node:util';

if (!global.TextEncoder) {
  global.TextEncoder = TextEncoder;
}
if (!global.TextDecoder) {
  // @ts-ignore - jsdom types mismatch with Node's TextDecoder
  global.TextDecoder = TextDecoder;
}

// JSDOM does not implement matchMedia; components that query it (theme
// detection, responsive hooks) crash on import without this stub.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
}
