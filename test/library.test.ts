// Library icons placed by the MCP. The arrow tests use the real converter, so they need `npm run build`.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConverter } from "../server/convert.ts";
import { addElements, deleteElements, describe as describeBoard, updateElements } from "../server/edit.ts";
import { type LibraryItem, findItem, normalizeItems, placeItem, searchLibrary } from "../server/library.ts";
import { type Element, emptyScene } from "../server/scene.ts";

const WORKER = path.resolve("dist/server/convert-worker.js");
const built = fs.existsSync(WORKER);
const convert = built ? createConverter(WORKER) : async () => [];

const el = (id: string, type: string, x: number, y: number, w: number, h: number, extra: Partial<Element> = {}): Element => ({
  id,
  type,
  x,
  y,
  width: w,
  height: h,
  version: 3,
  versionNonce: 1,
  isDeleted: false,
  groupIds: ["g-src"],
  ...extra,
});

// Shaped like the AWS pack: a 64px square, a glyph line, a caption below.
const lambda: LibraryItem = {
  id: "lib-lambda",
  name: "AWS: Lambda",
  elements: [
    el("sq", "rectangle", 1000, 1000, 64, 64),
    el("glyph", "line", 1010, 1010, 40, 40, { points: [[0, 0], [40, 40]] }),
    el("cap", "text", 1000, 1070, 64, 24, { text: "Lambda", originalText: "Lambda", fontSize: 16, textAlign: "center" }),
  ],
};
const region: LibraryItem = {
  id: "lib-region",
  name: "AWS: Region",
  elements: [el("box", "rectangle", 0, 0, 270, 165), el("icon", "rectangle", 0, 0, 40, 43), el("title", "text", 45, 9, 60, 25, { text: "Region" })],
};
const library = [lambda, region, { id: "x", name: "AWS: Lambda@Edge", elements: [el("q", "rectangle", 0, 0, 10, 10)] }];

describe("library lookup", () => {
  it("reads the old array format too", () => {
    expect(normalizeItems([[el("a", "rectangle", 0, 0, 1, 1)], { id: "b", elements: [] }, 7])).toHaveLength(2);
  });

  it("searches by all words, exact names first, with aliases as a fallback", () => {
    expect(searchLibrary(library, "aws lambda").items.map((i) => i.name)).toEqual(["AWS: Lambda", "AWS: Lambda@Edge"]);
    expect(searchLibrary(library, "lambda").items[0].name).toBe("AWS: Lambda");
    expect(searchLibrary(library, "function")).toMatchObject({ total: 2, via: "lambda" });
    expect(searchLibrary(library, "kafka").total).toBe(0);
    expect(findItem(library, "aws: lambda").id).toBe("lib-lambda");
    expect(() => findItem(library, "Lamb")).toThrow(/matches 2 items/);
    expect(() => findItem(library, "Kafka")).toThrow(/search_library/);
  });
});

describe("placeItem", () => {
  it("copies with fresh ids, moved to x/y, grouped, the square taking the agent's id", () => {
    const placed = placeItem(lambda, { x: 100, y: 200 }, "fn");
    expect(placed.map((e) => e.id)).toContain("fn");
    expect(placed.find((e) => e.id === "fn")).toMatchObject({ type: "rectangle", x: 100, y: 200, version: 1 });
    expect(new Set(placed.map((e) => e.id)).size).toBe(3);
    expect(placed.some((e) => ["sq", "glyph", "cap"].includes(e.id))).toBe(false);
    const groups = placed.map((e) => (e.groupIds as string[]).at(-1));
    expect(new Set(groups).size).toBe(1);
    expect(placed.every((e) => (e.customData as { library: string }).library === "AWS: Lambda")).toBe(true);
  });

  it("replaces the caption, keeping it centred", () => {
    const cap = placeItem(lambda, { x: 0, y: 0 }, "fn", "Orders fn").find((e) => e.type === "text")!;
    expect(cap.text).toBe("Orders fn");
    expect((cap.x as number) + (cap.width as number) / 2).toBeCloseTo(32);
  });

  it("resizes only the main element of a group box", () => {
    const placed = placeItem(region, { x: 0, y: 0 }, "reg", undefined, { width: 800, height: 500 });
    expect(placed.find((e) => e.id === "reg")).toMatchObject({ width: 800, height: 500 });
    expect(placed.find((e) => e.type === "text")).toMatchObject({ x: 45, y: 9 });
  });
});

describe.skipIf(!built)("library icons on a board", () => {
  const draw = () =>
    addElements(
      emptyScene("t"),
      [
        { type: "library", id: "fn", name: "AWS: Lambda", x: 0, y: 0, label: "Orders" },
        { type: "rectangle", id: "db", x: 400, y: 0, width: 160, height: 64, label: "DB" },
        { type: "arrow", id: "a", start: { id: "fn" }, end: { id: "db" } },
      ],
      convert,
      async () => library,
    );

  it("binds arrows to the icon", async () => {
    const { scene } = await draw();
    const arrow = scene.elements.find((e) => e.id === "a")!;
    expect(arrow.startBinding).toMatchObject({ elementId: "fn" });
    expect((scene.elements.find((e) => e.id === "fn")!.boundElements as { id: string }[]).map((b) => b.id)).toContain("a");
  });

  it("shows the icon as one entry, and moves and deletes it as one", async () => {
    const { scene } = await draw();
    expect(describeBoard(scene).elements.find((e) => e.id === "fn")).toMatchObject({ type: "library", name: "AWS: Lambda", label: "Orders" });
    expect(describeBoard(scene).count).toBe(3);

    const moved = updateElements(scene, [{ id: "fn", dy: 100 }]).scene;
    const before = scene.elements.find((e) => e.type === "text" && (e.customData as { library?: string })?.library)!;
    expect(moved.elements.find((e) => e.id === before.id)!.y).toBe((before.y as number) + 100);

    const relabelled = updateElements(scene, [{ id: "fn", label: "Payments" }]).scene;
    expect(relabelled.elements.find((e) => e.id === before.id)).toMatchObject({ text: "Payments" });

    const { scene: gone } = deleteElements(scene, ["fn"]);
    expect(gone.elements.filter((e) => (e.customData as { library?: string })?.library && !e.isDeleted)).toEqual([]);
  });
});
