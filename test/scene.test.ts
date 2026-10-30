import { describe, expect, it } from "vitest";
import { type Element, TOMBSTONE_TTL_MS, mergeElements, prune, wins } from "../server/scene.ts";

const el = (id: string, version: number, extra: Partial<Element> = {}): Element => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 100,
  isDeleted: false,
  index: `a${id}`,
  ...extra,
});

describe("wins", () => {
  it("prefers the higher version, then the lower nonce", () => {
    expect(wins(el("1", 3), el("1", 2))).toBe(true);
    expect(wins(el("1", 2), el("1", 3))).toBe(false);
    expect(wins(el("1", 2, { versionNonce: 5 }), el("1", 2, { versionNonce: 9 }))).toBe(true);
  });
});

describe("mergeElements", () => {
  it("keeps the newer copy of each element from either side", () => {
    const stored = [el("1", 5), el("2", 1)];
    const incoming = [el("1", 4), el("2", 2)];
    const { elements, tookStored } = mergeElements(stored, incoming);
    expect(elements.map((e) => [e.id, e.version])).toEqual([
      ["1", 5],
      ["2", 2],
    ]);
    expect(tookStored).toBe(true);
  });

  it("keeps elements the writer does not send: only tombstones delete", () => {
    expect(mergeElements([el("1", 1), el("2", 1)], [el("1", 1)]).elements.map((e) => e.id)).toEqual(["1", "2"]);
    // The 0.1.4 bug: a closing tab saved an empty scene. That must change nothing.
    const { elements, tookStored } = mergeElements([el("1", 1), el("2", 1)], []);
    expect(elements.map((e) => e.id)).toEqual(["1", "2"]);
    expect(tookStored).toBe(true);
    // A real delete is a newer tombstone, and wins.
    expect(mergeElements([el("1", 1)], [el("1", 2, { isDeleted: true })]).elements[0].isDeleted).toBe(true);
  });

  it("orders the result by fractional index", () => {
    const { elements } = mergeElements([el("b", 1, { index: "a1" })], [el("c", 1, { index: "a2" }), el("a", 1, { index: "a0" })]);
    expect(elements.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});

describe("prune", () => {
  it("drops old tombstones and unreferenced images, keeps the rest", () => {
    const now = Date.now();
    const scene = {
      type: "excalidraw" as const,
      version: 2 as const,
      source: "",
      appState: {},
      elements: [
        el("old", 2, { isDeleted: true, updated: now - TOMBSTONE_TTL_MS - 1 }),
        el("recent", 2, { isDeleted: true, updated: now - 1000 }),
        el("img", 1, { type: "image", fileId: "f1" }),
      ],
      files: {
        f1: { id: "f1", mimeType: "image/png", dataURL: "data:", created: 1 },
        f2: { id: "f2", mimeType: "image/png", dataURL: "data:", created: 1 },
      },
    };
    const out = prune(scene, now);
    expect(out.elements.map((e) => e.id)).toEqual(["recent", "img"]);
    expect(Object.keys(out.files)).toEqual(["f1"]);
  });
});
