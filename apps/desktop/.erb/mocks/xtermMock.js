// Mock for @xterm/xterm
module.exports = {
  Terminal: class MockTerminal {
    constructor() {
      this.element = null;
      this.textarea = null;
    }
    open() {}
    write() {}
    writeln() {}
    clear() {}
    reset() {}
    dispose() {}
    loadAddon() {}
    onData() { return { dispose: () => {} }; }
    onResize() { return { dispose: () => {} }; }
  }
};
