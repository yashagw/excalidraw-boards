// What the MCP tools do to a scene: add elements (through Excalidraw's own
// converter), change them, delete them, and describe a board compactly.
// Pure functions on a Scene; store.update() does the reading and writing.
import { randomBytes, randomInt } from "node:crypto";
import { generateNKeysBetween } from "fractional-indexing";
import type { Convert } from "./convert.ts";
import { type Box, type Point, anchorPoint, boundaryPoint, centerOf, textSize } from "./geometry.ts";
import { type LibraryItem, bounds, findItem, placeItem, placementGroup } from "./library.ts";
import { type Element, type Scene, bump } from "./scene.ts";

/** A mistake in the tool input; the message goes back to the agent. */
export class ToolError extends Error {}

export const ELEMENT_TYPES = ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "frame", "library"] as const;
const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const LINEAR = new Set(["arrow", "line"]);

type Raw = Record<string, unknown>;
type Skeleton = Raw & { type: string; id: string };
type Anchor = [number, number];
type BoundRef = { id: string; type: string };

const newId = () => randomBytes(15).toString("base64url");
const isLive = (e: Element) => !e.isDeleted;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round = (n: unknown) => (num(n) ? Math.round(n * 10) / 10 : n);

function boxOf(el: Raw): Box {
  if (el.type === "text" && (!num(el.width) || !num(el.height))) {
    const size = textSize(String(el.text ?? ""), num(el.fontSize) ? el.fontSize : 20);
    return { x: num(el.x) ? el.x : 0, y: num(el.y) ? el.y : 0, ...size, type: "text" };
  }
  return {
    x: num(el.x) ? el.x : 0,
    y: num(el.y) ? el.y : 0,
    width: num(el.width) ? el.width : 100,
    height: num(el.height) ? el.height : 100,
    type: String(el.type),
  };
}

const boundRefs = (el: Element) => (el.boundElements as BoundRef[] | null | undefined) ?? [];
const points = (el: Raw) => (el.points as [number, number][] | undefined) ?? [];

// ------------------------------------------------------------------ add

function normalize(raw: Raw, anchors: Map<string, { start?: Anchor; end?: Anchor }>): Skeleton {
  const sk: Raw = { ...raw };
  const type = sk.type;
  if (typeof type !== "string" || type === "library" || !(ELEMENT_TYPES as readonly string[]).includes(type)) {
    throw new ToolError(`unsupported element type ${JSON.stringify(type)}; use one of: ${ELEMENT_TYPES.join(", ")}`);
  }
  if (sk.id === undefined) sk.id = newId();
  if (typeof sk.id !== "string" || !sk.id) throw new ToolError("element ids must be non-empty strings");
  const id = sk.id;
  if (typeof sk.label === "string") sk.label = { text: sk.label };
  // The converter colours a label like its shape's outline, which is unreadable for
  // amber-on-yellow and similar. Labels are dark unless the agent says otherwise.
  if (sk.label && typeof sk.label === "object" && !(sk.label as Raw).strokeColor) {
    sk.label = { ...(sk.label as Raw), strokeColor: "#1e1e1e" };
  }
  if (type === "text" && typeof sk.text !== "string") throw new ToolError(`text element "${id}" needs "text"`);

  // The official Excalidraw MCP writes bindings as startBinding: { elementId, fixedPoint };
  // the converter wants start: { id }. Accept both.
  for (const end of ["start", "end"] as const) {
    const b = sk[`${end}Binding`] as { elementId?: unknown; fixedPoint?: unknown } | null | undefined;
    if (b && typeof b === "object" && typeof b.elementId === "string") {
      sk[end] = { id: b.elementId };
      if (Array.isArray(b.fixedPoint) && b.fixedPoint.length === 2 && b.fixedPoint.every(num)) {
        anchors.set(id, { ...anchors.get(id), [end]: b.fixedPoint as Anchor });
      }
    }
    delete sk[`${end}Binding`];
    const ref = sk[end] as Raw | undefined;
    if (ref !== undefined && (typeof ref !== "object" || ref === null || (typeof ref.id !== "string" && typeof ref.type !== "string"))) {
      throw new ToolError(`"${end}" of ${type} "${id}" must be { "id": "<element id>" }`);
    }
  }

  // A labelled shape without a size gets one that fits its label.
  if (SHAPES.has(type)) {
    const label = (sk.label as Raw | undefined)?.text;
    const text = typeof label === "string" ? textSize(label, num((sk.label as Raw).fontSize) ? ((sk.label as Raw).fontSize as number) : 20) : null;
    if (!num(sk.width)) sk.width = text ? Math.max(120, text.width + 40) : 100;
    if (!num(sk.height)) sk.height = text ? Math.max(60, text.height + 30) : 100;
  }

  const refId = (end: "start" | "end") => typeof (sk[end] as Raw | undefined)?.id === "string";
  const hasBinding = LINEAR.has(type) && (refId("start") || refId("end"));
  if (!hasBinding && (!num(sk.x) || !num(sk.y))) throw new ToolError(`${type} "${id}" needs numeric "x" and "y"`);

  // Fields the editor owns; the converter would otherwise copy them through.
  for (const k of ["version", "versionNonce", "index", "isDeleted", "boundElements", "containerId", "seed", "updated", "frameId"]) {
    delete sk[k];
  }
  return sk as Skeleton;
}

function setLine(sk: Skeleton, p1: Point, p2: Point) {
  const r = (n: number) => Math.round(n * 100) / 100;
  sk.x = r(p1.x);
  sk.y = r(p1.y);
  sk.points = [
    [0, 0],
    [r(p2.x - p1.x), r(p2.y - p1.y)],
  ];
  sk.width = Math.abs(r(p2.x - p1.x));
  sk.height = Math.abs(r(p2.y - p1.y));
}

/** Give a bound arrow its geometry: from the edge of one shape to the edge of the other. */
function route(sk: Skeleton, geometry: (id: string) => Box, anchor: { start?: Anchor; end?: Anchor } = {}) {
  const startId = (sk.start as Raw | undefined)?.id as string | undefined;
  const endId = (sk.end as Raw | undefined)?.id as string | undefined;
  const a = startId ? geometry(startId) : null;
  const b = endId ? geometry(endId) : null;
  if (Array.isArray(sk.points) && sk.points.length >= 2) {
    if (!num(sk.x) || !num(sk.y)) throw new ToolError(`${sk.type} "${sk.id}" has "points" but no "x"/"y"`);
    return; // explicit geometry: the converter only binds
  }
  if (a && b) {
    const p1 = anchor.start ? anchorPoint(a, anchor.start) : boundaryPoint(a, anchor.end ? anchorPoint(b, anchor.end) : centerOf(b));
    const p2 = anchor.end ? anchorPoint(b, anchor.end) : boundaryPoint(b, anchor.start ? anchorPoint(a, anchor.start) : centerOf(a));
    setLine(sk, p1, p2);
  } else if (a || b) {
    // One end bound: the free end is x/y (+ width/height).
    if (!num(sk.x) || !num(sk.y) || (!num(sk.width) && !num(sk.height))) {
      throw new ToolError(`${sk.type} "${sk.id}" is bound at one end only; give "x", "y", "width", "height" for the free end, or bind both ends`);
    }
    let p1: Point = { x: sk.x, y: sk.y };
    let p2: Point = { x: sk.x + (num(sk.width) ? sk.width : 0), y: sk.y + (num(sk.height) ? sk.height : 0) };
    if (a) p1 = anchor.start ? anchorPoint(a, anchor.start) : boundaryPoint(a, p2);
    if (b) p2 = anchor.end ? anchorPoint(b, anchor.end) : boundaryPoint(b, p1);
    setLine(sk, p1, p2);
  }
}

/** New elements go on top: fractional index keys after the highest one on the board. */
function placeOnTop(existing: readonly Element[], added: Element[]) {
  let max: string | null = null;
  for (const e of existing) if (typeof e.index === "string" && (max === null || e.index > max)) max = e.index;
  try {
    const keys = generateNKeysBetween(max, null, added.length);
    added.forEach((e, i) => (e.index = keys[i]));
  } catch {
    added.forEach((e) => (e.index = null)); // a malformed key on the board; the editor renumbers on load
  }
}

export async function addElements(
  scene: Scene,
  input: Raw[],
  convert: Convert,
  library: () => Promise<LibraryItem[]> = async () => [],
): Promise<{ scene: Scene; ids: string[] }> {
  if (input.length === 0) throw new ToolError("elements is empty");
  const all = new Set(scene.elements.map((e) => e.id));
  const live = new Map(scene.elements.filter(isLive).map((e) => [e.id, e]));
  const anchors = new Map<string, { start?: Anchor; end?: Anchor }>();
  const batch = new Map<string, Skeleton>();
  // Library placements are copied in whole, not converted; to the converter they are existing shapes.
  const placed: Element[] = [];
  const isPlaced = new Set<string>();
  for (const raw of input) {
    if (raw === null || typeof raw !== "object") throw new ToolError("every element must be an object");
    const id = raw.type === "library" ? (raw.id ?? newId()) : null;
    const sk = id === null ? normalize(raw, anchors) : null;
    const key = (id ?? sk!.id) as string;
    if (typeof key !== "string" || !key) throw new ToolError("element ids must be non-empty strings");
    if (all.has(key) || batch.has(key) || isPlaced.has(key)) {
      throw new ToolError(`id "${key}" is already used on this board (ids are never reused, even after a delete); choose a new id`);
    }
    if (sk) {
      batch.set(key, sk);
      continue;
    }
    if (typeof raw.name !== "string") throw new ToolError(`library element "${key}" needs "name" (see search_library)`);
    if (!num(raw.x) || !num(raw.y)) throw new ToolError(`library element "${key}" needs numeric "x" and "y"`);
    let item: LibraryItem;
    try {
      item = findItem(await library(), raw.name);
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    const label = typeof raw.label === "string" ? raw.label : ((raw.label as Raw | undefined)?.text as string | undefined);
    const size = { width: num(raw.width) ? raw.width : undefined, height: num(raw.height) ? raw.height : undefined };
    const els = placeItem(item, { x: raw.x, y: raw.y }, key, label, size);
    placed.push(...els);
    for (const e of els) {
      isPlaced.add(e.id);
      all.add(e.id);
    }
    live.set(key, els.find((e) => e.id === key)!);
  }

  // Existing elements that the new ones bind to or put in a frame.
  const external = new Set<string>();
  const geometry = (id: string): Box => {
    const sk = batch.get(id);
    if (sk) return boxOf(sk);
    const el = live.get(id);
    if (!el) throw new ToolError(`"${id}" is not on this board and not in this call`);
    external.add(id);
    return boxOf(el);
  };
  for (const sk of batch.values()) {
    if (LINEAR.has(sk.type)) route(sk, geometry, anchors.get(sk.id));
    if (sk.type === "frame" && Array.isArray(sk.children)) for (const child of sk.children) geometry(String(child));
  }

  // The converter only binds within one call, so existing elements go in as plain
  // stand-ins. Their new arrow bindings and frame membership are copied back below.
  const standIns = [...external].map((id) => {
    const el = live.get(id)!;
    return { ...boxOf(el), type: SHAPES.has(el.type) ? el.type : "rectangle", id };
  });
  let converted: Element[];
  try {
    converted = await convert([...standIns, ...batch.values()]);
  } catch (err) {
    throw new ToolError(`Excalidraw could not convert the elements: ${(err as Error).message}`);
  }

  const changed = new Map<string, Element>();
  const added: Element[] = [];
  for (const el of converted) {
    if (!external.has(el.id)) {
      added.push(el);
      continue;
    }
    const real = live.get(el.id)!;
    const have = new Set(boundRefs(real).map((b) => b.id));
    const extra = boundRefs(el).filter((b) => !have.has(b.id));
    const changes: Partial<Element> = {};
    if (extra.length) changes.boundElements = [...boundRefs(real), ...extra];
    if (el.frameId && el.frameId !== real.frameId) changes.frameId = el.frameId;
    if (!Object.keys(changes).length) continue;
    if (isPlaced.has(real.id)) Object.assign(real, changes); // new in this call: no version to bump
    else changed.set(real.id, bump(real, changes));
  }
  const fresh = [...placed, ...added];
  placeOnTop(scene.elements, fresh);
  return {
    scene: { ...scene, elements: [...scene.elements.map((e) => changed.get(e.id) ?? e), ...fresh] },
    ids: fresh.map((e) => e.id),
  };
}

// ------------------------------------------------------------------ update

const STYLE_KEYS = new Set([
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "angle",
  "link",
  "locked",
]);
const LINEAR_KEYS = new Set(["startArrowhead", "endArrowhead"]);
export const UPDATE_KEYS = [
  "x",
  "y",
  "dx",
  "dy",
  "width",
  "height",
  "text",
  "label",
  "fontSize",
  "textAlign",
  "points",
  ...STYLE_KEYS,
  ...LINEAR_KEYS,
];

function linearAbs(el: Raw): Point[] {
  return points(el).map(([px, py]) => ({ x: (el.x as number) + px, y: (el.y as number) + py }));
}

function setLinearAbs(el: Raw, abs: Point[]) {
  const [first] = abs;
  el.x = first.x;
  el.y = first.y;
  el.points = abs.map((p) => [p.x - first.x, p.y - first.y]);
  const xs = abs.map((p) => p.x);
  const ys = abs.map((p) => p.y);
  el.width = Math.max(...xs) - Math.min(...xs);
  el.height = Math.max(...ys) - Math.min(...ys);
}

function midpoint(el: Raw): Point {
  const abs = linearAbs(el);
  if (abs.length % 2 === 1) return abs[(abs.length - 1) / 2];
  const a = abs[abs.length / 2 - 1];
  const b = abs[abs.length / 2];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function sizeText(text: Raw) {
  const { width, height } = textSize(String(text.text ?? ""), num(text.fontSize) ? text.fontSize : 20, num(text.lineHeight) ? text.lineHeight : 1.25);
  text.width = width;
  text.height = height;
}

function centerLabel(text: Raw, container: Raw) {
  const c = LINEAR.has(String(container.type)) ? midpoint(container) : centerOf(boxOf(container));
  text.x = c.x - (text.width as number) / 2;
  text.y = c.y - (text.height as number) / 2;
}

function newLabel(container: Element, text: string, fontSize: number): Element {
  const label: Element = {
    id: newId(),
    type: "text",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: (container.type === "arrow" ? container.strokeColor : "#1e1e1e") ?? "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: randomInt(2 ** 31),
    version: 1,
    versionNonce: randomInt(2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    text,
    fontSize,
    fontFamily: 5,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: container.id,
    originalText: text,
    autoResize: true,
    lineHeight: 1.25,
  };
  sizeText(label);
  return label;
}

export function updateElements(scene: Scene, updates: Raw[]): { scene: Scene; ids: string[]; warnings: string[] } {
  if (updates.length === 0) throw new ToolError("updates is empty");
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const drafts = new Map<string, Element>();
  const created: Element[] = [];
  const warnings: string[] = [];
  const moved = new Map<string, Point>();
  const relabel = new Set<string>(); // containers whose label must be re-centred

  const get = (id: string) => drafts.get(id) ?? byId.get(id);
  const draft = (id: string) => {
    let d = drafts.get(id);
    if (!d) drafts.set(id, (d = { ...byId.get(id)! }));
    return d;
  };
  /** The other elements of a library placement, when `el` is its main element. */
  const siblings = (el: Element) => {
    const g = (el.customData as { libraryMain?: boolean } | undefined)?.libraryMain ? placementGroup(el) : null;
    return g ? scene.elements.filter((e) => isLive(e) && e.id !== el.id && (e.groupIds as string[] | undefined)?.includes(g)) : [];
  };
  const labelOf = (el: Element) => {
    const ref = boundRefs(el).find((b) => b.type === "text");
    const text = ref && get(ref.id);
    return text && !text.isDeleted ? text : undefined;
  };
  const setText = (id: string, value: string) => {
    const t = draft(id);
    const before = { x: t.x as number, width: t.width as number };
    t.text = value;
    t.originalText = value;
    sizeText(t);
    if (t.containerId) relabel.add(t.containerId as string);
    else if (t.textAlign === "center") t.x = before.x + before.width / 2 - (t.width as number) / 2;
    else if (t.textAlign === "right") t.x = before.x + before.width - (t.width as number);
  };

  for (const u of updates) {
    const id = u?.id;
    if (typeof id !== "string") throw new ToolError('every update needs an "id"');
    const original = get(id);
    if (!original || original.isDeleted) throw new ToolError(`no element "${id}" on this board`);
    const type = original.type;

    for (const [key, value] of Object.entries(u)) {
      if (key === "id") continue;
      if (!UPDATE_KEYS.includes(key) || (LINEAR_KEYS.has(key) && !LINEAR.has(type))) {
        warnings.push(`ignored "${key}" on ${id}`);
        continue;
      }
      if (["x", "y", "dx", "dy", "width", "height", "fontSize"].includes(key) && !num(value)) {
        throw new ToolError(`"${key}" on ${id} must be a number`);
      }
      const d = draft(id);
      if (key === "x" || key === "y" || key === "dx" || key === "dy") {
        const axis = key.endsWith("x") ? "x" : "y";
        const delta = key.startsWith("d") ? (value as number) : (value as number) - (d[axis] as number);
        d[axis] = (d[axis] as number) + delta;
        const m = moved.get(id) ?? { x: 0, y: 0 };
        m[axis] += delta;
        moved.set(id, m);
      } else if (key === "width" || key === "height") {
        d[key] = value;
        relabel.add(id);
      } else if (key === "points") {
        if (!LINEAR.has(type) || !Array.isArray(value) || value.length < 2 || !value.every((p) => Array.isArray(p) && p.length === 2 && p.every(num))) {
          throw new ToolError(`"points" on ${id} must be [[x, y], ...] with at least two points, on an arrow or line`);
        }
        setLinearAbs(d, (value as Anchor[]).map(([px, py]) => ({ x: (d.x as number) + px, y: (d.y as number) + py })));
        relabel.add(id);
      } else if (key === "text" || key === "label") {
        if (typeof value !== "string") throw new ToolError(`"${key}" on ${id} must be a string`);
        if (type === "text") {
          setText(id, value);
          continue;
        }
        const caption = siblings(d).filter((e) => e.type === "text" && !e.containerId);
        if (caption.length === 1) {
          setText(caption[0].id, value); // a library icon's own caption, e.g. "Lambda"
          continue;
        }
        const label = labelOf(d);
        if (label && value === "") {
          draft(label.id).isDeleted = true;
          d.boundElements = boundRefs(d).filter((b) => b.id !== label.id);
        } else if (label) {
          setText(label.id, value);
        } else if (value !== "") {
          const fresh = newLabel(d, value, num(u.fontSize) ? u.fontSize : 20);
          created.push(fresh);
          byId.set(fresh.id, fresh);
          d.boundElements = [...boundRefs(d), { type: "text", id: fresh.id }];
          relabel.add(id);
        }
      } else if (key === "fontSize") {
        const target = type === "text" ? d : labelOf(d) && draft(labelOf(d)!.id);
        if (!target) {
          warnings.push(`"fontSize" on ${id}: it has no text`);
          continue;
        }
        target.fontSize = value;
        setText(target.id, String(target.text ?? ""));
      } else if (key === "textAlign") {
        if (type !== "text") warnings.push(`ignored "textAlign" on ${id}: not a text element`);
        else d.textAlign = value;
      } else {
        d[key] = value;
      }
    }
  }

  // Things attached to what moved: labels move along, bound arrows re-route.
  for (const [id, delta] of moved) {
    const el = get(id)!;
    if (LINEAR.has(el.type)) {
      relabel.add(id);
      continue;
    }
    for (const sib of siblings(el)) {
      const d = draft(sib.id);
      d.x = (d.x as number) + delta.x;
      d.y = (d.y as number) + delta.y;
    }
    const label = labelOf(el);
    if (label) relabel.add(id);
    for (const ref of boundRefs(el)) {
      if (ref.type !== "arrow" || moved.has(ref.id)) continue;
      const arrow = get(ref.id);
      if (!arrow || arrow.isDeleted) continue;
      const d = draft(arrow.id);
      const abs = linearAbs(d);
      const start = (d.startBinding as { elementId?: string } | null)?.elementId;
      const end = (d.endBinding as { elementId?: string } | null)?.elementId;
      if (start === id || end === id) {
        const box = (eid: string | undefined) => (eid && get(eid) ? boxOf(get(eid)!) : null);
        const sb = box(start);
        const eb = box(end);
        const last = abs.length - 1;
        if (abs.length === 2) {
          const p1 = sb ? boundaryPoint(sb, eb ? centerOf(eb) : abs[last]) : abs[0];
          const p2 = eb ? boundaryPoint(eb, sb ? centerOf(sb) : abs[0]) : abs[last];
          abs[0] = p1;
          abs[last] = p2;
        } else {
          if (start === id) abs[0] = { x: abs[0].x + delta.x, y: abs[0].y + delta.y };
          if (end === id) abs[last] = { x: abs[last].x + delta.x, y: abs[last].y + delta.y };
        }
        setLinearAbs(d, abs);
        relabel.add(arrow.id);
      }
    }
  }
  for (const id of relabel) {
    const container = get(id)!;
    const label = labelOf(container);
    if (label) centerLabel(draft(label.id), container);
  }

  if (created.length) placeOnTop(scene.elements, created);
  const elements = scene.elements.map((e) => (drafts.has(e.id) ? bump(e, drafts.get(e.id)) : e));
  for (const c of created) elements.push(drafts.has(c.id) ? { ...c, ...drafts.get(c.id) } : c);
  return { scene: { ...scene, elements }, ids: [...new Set(updates.map((u) => u.id as string))], warnings };
}

// ------------------------------------------------------------------ delete

export function deleteElements(scene: Scene, ids: string[]): { scene: Scene; ids: string[] } {
  if (ids.length === 0) throw new ToolError("ids is empty");
  const live = new Map(scene.elements.filter(isLive).map((e) => [e.id, e]));
  const drop = new Set<string>();
  for (const id of ids) {
    if (!live.has(id)) throw new ToolError(`no element "${id}" on this board`);
    drop.add(id);
  }
  // A library icon goes as a whole, labels go with their shape or arrow.
  for (const id of [...drop]) {
    const main = live.get(id)!;
    const g = (main.customData as { libraryMain?: boolean } | undefined)?.libraryMain ? placementGroup(main) : null;
    if (g) for (const e of live.values()) if ((e.groupIds as string[] | undefined)?.includes(g)) drop.add(e.id);
  }
  for (const e of live.values()) if (typeof e.containerId === "string" && drop.has(e.containerId)) drop.add(e.id);

  const elements = scene.elements.map((e) => {
    if (!isLive(e)) return e;
    if (drop.has(e.id)) return bump(e, { isDeleted: true });
    const changes: Partial<Element> = {};
    const refs = boundRefs(e);
    if (refs.some((b) => drop.has(b.id))) changes.boundElements = refs.filter((b) => !drop.has(b.id));
    for (const end of ["startBinding", "endBinding"] as const) {
      const b = e[end] as { elementId?: string } | null | undefined;
      if (b?.elementId && drop.has(b.elementId)) changes[end] = null;
    }
    if (typeof e.frameId === "string" && drop.has(e.frameId)) changes.frameId = null;
    return Object.keys(changes).length ? bump(e, changes) : e;
  });
  return { scene: { ...scene, elements }, ids: [...drop] };
}

// ------------------------------------------------------------------ describe

const DEFAULT_STYLE: Raw = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
};

/** A compact view of a board for an agent: no bound text elements (they are the `label` of their container), default styles left out. */
export function describe(scene: Scene) {
  const live = scene.elements.filter(isLive);
  const byId = new Map(live.map((e) => [e.id, e]));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const out: Raw[] = [];
  // A library icon (many elements) is one entry, under its main element's id.
  const placements = new Map<string, Element[]>();
  for (const e of live) {
    const g = placementGroup(e);
    if (g) placements.set(g, [...(placements.get(g) ?? []), e]);
  }
  const isMain = (e: Element) => Boolean((e.customData as { libraryMain?: boolean } | undefined)?.libraryMain);

  for (const e of live) {
    const abs = LINEAR.has(e.type) || e.type === "freedraw" ? linearAbs(e) : null;
    const xs = abs ? abs.map((p) => p.x) : [e.x as number, (e.x as number) + (e.width as number)];
    const ys = abs ? abs.map((p) => p.y) : [e.y as number, (e.y as number) + (e.height as number)];
    minX = Math.min(minX, ...xs);
    minY = Math.min(minY, ...ys);
    maxX = Math.max(maxX, ...xs);
    maxY = Math.max(maxY, ...ys);

    const members = placements.get(placementGroup(e) ?? "");
    if (members?.some(isMain)) {
      if (!isMain(e)) continue;
      const b = bounds(members);
      const caption = members.filter((m) => m.type === "text" && !m.containerId);
      out.push({
        id: e.id,
        type: "library",
        name: (e.customData as { library: string }).library,
        x: round(b.x),
        y: round(b.y),
        width: round(b.width),
        height: round(b.height),
        ...(caption.length === 1 ? { label: caption[0].originalText ?? caption[0].text } : {}),
      });
      continue;
    }
    if (e.type === "text" && typeof e.containerId === "string" && byId.has(e.containerId)) continue;
    const d: Raw = { id: e.id, type: e.type, x: round(e.x), y: round(e.y), width: round(e.width), height: round(e.height) };
    if (e.type === "text") {
      d.text = e.originalText ?? e.text;
      d.fontSize = e.fontSize;
    }
    const labelRef = boundRefs(e).find((b) => b.type === "text");
    const label = labelRef && byId.get(labelRef.id);
    if (label) d.label = label.originalText ?? label.text;
    if (LINEAR.has(e.type)) {
      d.points = points(e).map(([px, py]) => [round(px), round(py)]);
      const start = (e.startBinding as { elementId?: string } | null)?.elementId;
      const end = (e.endBinding as { elementId?: string } | null)?.elementId;
      if (start) d.start = start;
      if (end) d.end = end;
      if (e.type === "arrow" && e.endArrowhead !== "arrow") d.endArrowhead = e.endArrowhead;
      if (e.startArrowhead) d.startArrowhead = e.startArrowhead;
    }
    if (e.type === "freedraw") delete d.points;
    for (const [k, v] of Object.entries(DEFAULT_STYLE)) if (e[k] !== undefined && e[k] !== v) d[k] = e[k];
    if (e.frameId) d.frameId = e.frameId;
    if (e.type === "frame" && e.name) d.name = e.name;
    if (Array.isArray(e.groupIds) && e.groupIds.length) d.groupIds = e.groupIds;
    if (e.link) d.link = e.link;
    out.push(d);
  }
  const extent = live.length ? { x: round(minX), y: round(minY), width: round(maxX - minX), height: round(maxY - minY) } : null;
  return { count: out.length, bounds: extent, elements: out };
}
