import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Element } from "../server/scene.ts";
import { Store, type StoreEvent } from "../server/store.ts";

const el = (id: string, version: number, extra: Partial<Element> = {}): Element => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 1,
  isDeleted: false,
  updated: Date.now(),
  index: `a${id}`,
  ...extra,
});

let dir: string;
let store: Store;
let events: StoreEvent[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "boards-"));
  store = new Store(dir, "test");
  await store.init();
  events = [];
  store.events.on("event", (e: StoreEvent) => events.push(e));
});

afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe("Store", () => {
  it("creates boards as .excalidraw files in folders, and refuses duplicates", async () => {
    await store.create("Work/Arch", "tab");
    const text = await fs.readFile(path.join(dir, "boards/Work/Arch.excalidraw"), "utf8");
    expect(JSON.parse(text)).toMatchObject({ type: "excalidraw", version: 2, elements: [] });
    await expect(store.create("Work/Arch", "tab")).rejects.toMatchObject({ status: 409 });
    expect(await store.tree()).toMatchObject({ folders: ["Work"], boards: [{ id: "Work/Arch" }] });
  });

  it("takes a save as-is when it starts from the current version", async () => {
    const { etag } = await store.create("b", "tab");
    const res = await store.save("b", { elements: [el("1", 1)] }, "tab");
    expect(res.merged).toBeNull();
    expect((await store.read("b")).scene.elements.map((e) => e.id)).toEqual(["1"]);
    expect(events.at(-1)).toMatchObject({ type: "board", id: "b", by: "tab" });
  });

  it("merges a stale save with what an agent wrote meanwhile, and returns the merge", async () => {
    const { etag: base } = await store.create("b", "tab");
    const first = await store.save("b", { elements: [el("1", 1)] }, "tab");
    // The agent adds element 2 after the tab's last save...
    await store.update("b", "mcp", async (scene) => ({ scene: { ...scene, elements: [...scene.elements, el("2", 1)] }, result: null }));
    // ...and the tab, still on its old version, edits element 1.
    const res = await store.save("b", { elements: [el("1", 2)] }, "tab");
    expect(res.merged?.elements.map((e) => [e.id, e.version])).toEqual([
      ["1", 2],
      ["2", 1],
    ]);
  });

  it("does not write or announce a save that changes nothing", async () => {
    const { etag } = await store.create("b", "tab");
    const same = el("1", 1);
    const saved = await store.save("b", { elements: [same] }, "tab");
    const count = events.length;
    const again = await store.save("b", { elements: [same], appState: (await store.read("b")).scene.appState }, "tab");
    expect(again.etag).toBe(saved.etag);
    expect(events.length).toBe(count);
  });

  it("never lets a save wipe a board, and snapshots the version it replaces", async () => {
    await store.create("b", "tab");
    await store.save("b", { elements: [el("1", 1), el("2", 1)] }, "tab");
    const res = await store.save("b", { elements: [] }, "tab");
    expect((await store.read("b")).scene.elements.map((e) => e.id)).toEqual(["1", "2"]);
    expect(res.merged?.elements).toHaveLength(2);
    const history = await fs.readdir(path.join(dir, "history"));
    expect(history).toEqual(["b"]);
    expect((await fs.readdir(path.join(dir, "history", "b"))).length).toBe(1); // one per 10 minutes
  });

  it("404s a save to a board that is gone", async () => {
    await expect(store.save("nope", { elements: [] }, "tab")).rejects.toMatchObject({ status: 404 });
  });

  it("moves boards and folders, and not a folder into itself", async () => {
    await store.create("A/x", "tab");
    await store.move("board", "A/x", "B/y");
    await store.move("folder", "B", "C/B");
    expect((await store.tree()).boards.map((b) => b.id)).toEqual(["C/B/y"]);
    await expect(store.move("folder", "C", "C/B/inner")).rejects.toMatchObject({ status: 400 });
    expect(events).toContainEqual({ type: "moved", kind: "folder", from: "B", to: "C/B" });
  });

  it("deletes into trash/ instead of removing the file", async () => {
    await store.create("Work/Arch", "tab");
    await store.remove("folder", "Work");
    expect((await store.tree()).boards).toEqual([]);
    const trash = await fs.readdir(path.join(dir, "trash"));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(/Work$/);
  });
});
