// Runs Excalidraw's real converter, so it needs the server build (npm run build) first.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConverter } from "../server/convert.ts";
import { ToolError, addElements, deleteElements, describe as describeBoard, updateElements } from "../server/edit.ts";
import { type Element, type Scene, emptyScene } from "../server/scene.ts";

const WORKER = path.resolve("dist/server/convert-worker.js");
const built = fs.existsSync(WORKER);
const convert = built ? createConverter(WORKER) : async () => [];

const byId = (scene: Scene) => new Map(scene.elements.map((e) => [e.id, e]));
const boundIds = (e: Element | undefined) => ((e?.boundElements as { id: string }[] | null) ?? []).map((b) => b.id);

const diagram = [
  { type: "rectangle", id: "web", x: 0, y: 0, width: 200, height: 100, label: "Web" },
  { type: "rectangle", id: "api", x: 400, y: 0, width: 200, height: 100, label: { text: "API", fontSize: 24 } },
  { type: "arrow", id: "a1", start: { id: "web" }, end: { id: "api" }, label: "REST" },
];

describe.skipIf(!built)("addElements", () => {
  it("draws labelled shapes and routes a bound arrow edge to edge", async () => {
    const { scene, ids } = await addElements(emptyScene("t"), diagram, convert);
    const m = byId(scene);
    const arrow = m.get("a1")!;
    expect(arrow.startBinding).toMatchObject({ elementId: "web" });
    expect(arrow.endBinding).toMatchObject({ elementId: "api" });
    // Starts just right of web (x=200) and ends just left of api (x=400).
    expect(arrow.x as number).toBeGreaterThan(200);
    expect((arrow.x as number) + (arrow.width as number)).toBeLessThan(400);
    expect(boundIds(m.get("web"))).toContain("a1");
    const label = scene.elements.find((e) => e.containerId === "api")!;
    expect(label).toMatchObject({ type: "text", text: "API", fontSize: 24, strokeColor: "#1e1e1e" });
    // All new elements, labels included, get increasing z-order keys.
    const keys = scene.elements.map((e) => e.index as string);
    expect([...keys].sort()).toEqual(keys);
    expect(ids).toHaveLength(scene.elements.length);
  });

  it("binds a new arrow to an existing shape and updates that shape", async () => {
    const first = await addElements(emptyScene("t"), diagram, convert);
    const before = byId(first.scene).get("api")!;
    const { scene } = await addElements(
      first.scene,
      [
        { type: "ellipse", id: "db", x: 400, y: 300, width: 200, height: 100, label: "DB" },
        { type: "arrow", id: "a2", startBinding: { elementId: "api", fixedPoint: [0.5, 1] }, endBinding: { elementId: "db", fixedPoint: [0.5, 0] } },
      ],
      convert,
    );
    const m = byId(scene);
    expect(m.get("a2")!.startBinding).toMatchObject({ elementId: "api" });
    expect(boundIds(m.get("api"))).toContain("a2");
    expect(m.get("api")!.version).toBe(before.version + 1);
    // fixedPoint [0.5, 1] = middle of api's bottom edge.
    expect(m.get("a2")).toMatchObject({ x: 500, y: 100 });
    // New elements are above the old ones.
    expect((m.get("db")!.index as string) > (m.get("a1")!.index as string)).toBe(true);
  });

  it("refuses reused ids and unknown types with a message for the agent", async () => {
    const { scene } = await addElements(emptyScene("t"), diagram, convert);
    await expect(addElements(scene, [{ type: "rectangle", id: "web", x: 0, y: 0 }], convert)).rejects.toThrow(ToolError);
    await expect(addElements(scene, [{ type: "star", x: 0, y: 0 }], convert)).rejects.toThrow(/unsupported element type/);
    await expect(addElements(scene, [{ type: "arrow", start: { id: "ghost" }, end: { id: "web" } }], convert)).rejects.toThrow(/ghost/);
  });
});

describe.skipIf(!built)("updateElements / deleteElements", () => {
  it("moves a shape with its label, and re-routes the arrows bound to it", async () => {
    const { scene } = await addElements(emptyScene("t"), diagram, convert);
    const label = scene.elements.find((e) => e.containerId === "api")!;
    const { scene: next } = updateElements(scene, [{ id: "api", dy: 300 }]);
    const m = byId(next);
    expect(m.get("api")).toMatchObject({ y: 300 });
    expect((m.get(label.id)!.y as number) - (label.y as number)).toBeCloseTo(300);
    const arrow = m.get("a1")!;
    const end = (arrow.points as number[][]).at(-1)!;
    expect((arrow.y as number) + end[1]).toBeGreaterThan(250); // now heads down to api
  });

  it("changes, adds and removes labels", async () => {
    const { scene } = await addElements(emptyScene("t"), [{ type: "rectangle", id: "r", x: 0, y: 0, width: 200, height: 100 }], convert);
    const added = updateElements(scene, [{ id: "r", label: "Hello" }]).scene;
    const text = added.elements.find((e) => e.containerId === "r")!;
    expect(text).toMatchObject({ text: "Hello", type: "text" });
    expect((text.x as number) + (text.width as number) / 2).toBeCloseTo(100);
    const changed = updateElements(added, [{ id: "r", label: "Hi" }]).scene;
    expect(changed.elements.find((e) => e.id === text.id)).toMatchObject({ text: "Hi" });
    const removed = updateElements(changed, [{ id: "r", label: "" }]).scene;
    expect(removed.elements.find((e) => e.id === text.id)!.isDeleted).toBe(true);
  });

  it("deletes labels with their shape and unbinds arrows", async () => {
    const { scene } = await addElements(emptyScene("t"), diagram, convert);
    const { scene: next, ids } = deleteElements(scene, ["api"]);
    const m = byId(next);
    expect(ids).toHaveLength(2); // api and its label
    expect(m.get("a1")!.endBinding).toBeNull();
    expect(m.get("a1")!.isDeleted).toBe(false);
    expect(() => deleteElements(next, ["api"])).toThrow(ToolError);
  });

  it("describes a board without its bound text elements", async () => {
    const { scene } = await addElements(emptyScene("t"), diagram, convert);
    const d = describeBoard(scene);
    expect(d.count).toBe(3);
    expect(d.elements.find((e) => e.id === "a1")).toMatchObject({ start: "web", end: "api", label: "REST" });
    expect(d.elements.find((e) => e.id === "web")).not.toHaveProperty("strokeColor");
  });
});
