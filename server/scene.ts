// The .excalidraw file format, and the merge that lets the browser and the MCP
// write to the same board without losing each other's changes.
import { randomInt } from "node:crypto";

export type Element = {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  updated?: number;
  index?: string | null;
  [key: string]: unknown;
};

export type BinaryFile = {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
  lastRetrieved?: number;
};

export type Scene = {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: Element[];
  appState: Record<string, unknown>;
  files: Record<string, BinaryFile>;
};

// Deleted elements stay in the file as tombstones, so that a tab that still has
// the element cannot bring it back on its next save. After a week they go.
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function emptyScene(source: string): Scene {
  return { type: "excalidraw", version: 2, source, elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} };
}

export function parseScene(text: string): Scene {
  const data = JSON.parse(text);
  if (data?.type !== "excalidraw" || !Array.isArray(data.elements)) throw new Error("not an Excalidraw scene");
  return {
    type: "excalidraw",
    version: 2,
    source: typeof data.source === "string" ? data.source : "",
    elements: data.elements,
    appState: data.appState ?? {},
    files: data.files ?? {},
  };
}

// Same layout as Excalidraw's own "Save to disk", so the file opens anywhere.
export function serializeScene(scene: Scene): string {
  return JSON.stringify(scene, null, 2);
}

export function isElementList(value: unknown): value is Element[] {
  return (
    Array.isArray(value) &&
    value.every(
      (e) =>
        e !== null &&
        typeof e === "object" &&
        typeof e.id === "string" &&
        typeof e.type === "string" &&
        Number.isFinite(e.version) &&
        Number.isFinite(e.versionNonce),
    )
  );
}

/** Excalidraw's reconcile rule: the higher version wins; on a tie, the lower versionNonce wins. */
export function wins(a: Element, b: Element): boolean {
  return a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);
}

/**
 * Merge a writer's elements into the stored ones, per element.
 *
 * A stored element the writer does not send is kept. Elements leave a board only
 * as tombstones (isDeleted, which is how Excalidraw itself deletes), so a client
 * that sends too little, or nothing, can never wipe a board.
 */
export function mergeElements(stored: readonly Element[], incoming: readonly Element[]): { elements: Element[]; tookStored: boolean } {
  const storedById = new Map(stored.map((e) => [e.id, e]));
  const incomingIds = new Set<string>();
  const out: Element[] = [];
  let tookStored = false;

  for (const el of incoming) {
    incomingIds.add(el.id);
    const s = storedById.get(el.id);
    if (s && wins(s, el)) {
      out.push(s);
      tookStored = true;
    } else {
      out.push(el);
    }
  }
  for (const s of stored) {
    if (incomingIds.has(s.id)) continue;
    out.push(s);
    tookStored = true;
  }
  return { elements: orderByIndex(out), tookStored };
}

/** z-order is the fractional `index`; its keys sort with plain string comparison. */
export function orderByIndex(elements: Element[]): Element[] {
  if (!elements.every((e) => typeof e.index === "string")) return elements;
  return [...elements].sort((a, b) => {
    const ai = a.index as string;
    const bi = b.index as string;
    if (ai !== bi) return ai < bi ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Drop old tombstones, and images that no element refers to any more. */
export function prune(scene: Scene, now = Date.now()): Scene {
  const elements = scene.elements.filter((e) => !(e.isDeleted && (e.updated ?? 0) < now - TOMBSTONE_TTL_MS));
  const used = new Set(elements.flatMap((e) => (typeof e.fileId === "string" ? [e.fileId] : [])));
  const files = Object.fromEntries(Object.entries(scene.files).filter(([id]) => used.has(id)));
  return { ...scene, elements, files };
}

/** A changed copy of an element, with the version bump every editor change needs. */
export function bump<T extends Element>(el: T, changes: Partial<Element> = {}): T {
  return { ...el, ...changes, version: el.version + 1, versionNonce: randomInt(2 ** 31), updated: Date.now() };
}
