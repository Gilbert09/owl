// mermaid is pure ESM and can't be required by ts-jest's CommonJS transform.
// The real rendering also needs SVG measurement APIs jsdom does not implement
// (getBBox and friends), so the tests assert the wiring — that a ```mermaid
// fence reaches mermaid.render, with the security config we expect — against
// this stub rather than against a real diagram.
const calls = { initialize: [], render: [] };

const mermaid = {
  initialize(config) {
    calls.initialize.push(config);
  },
  async render(id, code) {
    calls.render.push({ id, code });
    return { svg: `<svg data-stub-mermaid="${id}"></svg>` };
  },
};

module.exports = { __esModule: true, default: mermaid, __calls: calls };
