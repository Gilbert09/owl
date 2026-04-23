// Jest can't resolve @pierre/diffs/react — the package's `exports` field
// uses subpath conditions that the default Node resolver doesn't understand.
// The App smoke test never renders a diff panel, so stub the components
// with no-op divs. Real runtime uses webpack, which resolves ESM cleanly.
const React = require('react');
const stub = (tag) => (props) => React.createElement('div', { 'data-pierre-stub': tag, ...props });
module.exports = {
  PatchDiff: stub('PatchDiff'),
  FileDiff: stub('FileDiff'),
  MultiFileDiff: stub('MultiFileDiff'),
};
