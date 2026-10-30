// Just enough of a browser for @excalidraw/excalidraw to load in a worker thread.
// The package touches window, document and canvas at import time; the converter
// itself only needs text widths, which convert-worker.ts supplies. Never import
// this in the main thread: Express and the MCP SDK must not see a fake `window`.
const g = globalThis as Record<string, unknown>;
const noop = () => {};
const element = () => ({
  style: {},
  classList: { add: noop, remove: noop },
  setAttribute: noop,
  appendChild: noop,
  addEventListener: noop,
  removeEventListener: noop,
  getContext: () => ({ filter: "none", measureText: (text: string) => ({ width: text.length * 10 }) }),
});

g.window = g;
g.devicePixelRatio = 1;
g.addEventListener = noop;
g.removeEventListener = noop;
g.document = {
  createElement: element,
  createElementNS: element,
  addEventListener: noop,
  removeEventListener: noop,
  querySelector: () => null,
  documentElement: { style: {} },
  head: { appendChild: noop },
  body: { appendChild: noop },
  fonts: { add: noop, check: () => true, load: async () => [], addEventListener: noop },
};
g.location = new URL("http://localhost/");
g.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
g.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 16);
g.cancelAnimationFrame = clearTimeout;
for (const name of ["Element", "HTMLElement", "SVGElement", "Node", "HTMLCanvasElement", "HTMLImageElement", "Image"]) {
  g[name] = class {};
}
g.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
g.FontFace = class {
  load() {
    return Promise.resolve(this);
  }
};
