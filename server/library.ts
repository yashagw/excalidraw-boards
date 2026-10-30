// Library items (icon packs like "AWS: Lambda") placed on a board by the MCP.
// A placement is a copy of the item's elements with fresh ids, moved into place
// and grouped, so it drags as one. Its main element (the largest shape) takes the
// agent's id, which is what arrows bind to; every element carries
// customData.library so read_board can show the placement as one thing.
import { randomBytes, randomInt } from "node:crypto";
import type { Element } from "./scene.ts";

export type LibraryItem = { id: string; name?: string; status?: string; elements: Element[] };

const newId = () => randomBytes(15).toString("base64url");
const BINDABLE = new Set(["rectangle", "ellipse", "diamond"]);

/** Library files can be in the old format, where an item is just an array of elements. */
export function normalizeItems(raw: unknown[]): LibraryItem[] {
  return raw.flatMap((it, i) => {
    if (Array.isArray(it)) return [{ id: `item-${i}`, elements: it as Element[] }];
    if (it && typeof it === "object" && Array.isArray((it as LibraryItem).elements)) return [it as LibraryItem];
    return [];
  });
}

export function bounds(elements: readonly Element[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements) {
    const x = e.x as number;
    const y = e.y as number;
    const pts = Array.isArray(e.points) ? (e.points as [number, number][]) : null;
    const xs = pts?.length ? pts.map(([px]) => x + px) : [x, x + (e.width as number)];
    const ys = pts?.length ? pts.map(([, py]) => y + py) : [y, y + (e.height as number)];
    minX = Math.min(minX, ...xs);
    minY = Math.min(minY, ...ys);
    maxX = Math.max(maxX, ...xs);
    maxY = Math.max(maxY, ...ys);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

const live = (item: LibraryItem) => item.elements.filter((e) => !e.isDeleted);

/**
 * The names agents use: the item's own name, unless several items share it (as
 * in packs that only name the pack); those get their own text appended
 * ("System Design Components: Relational DB"). Items still ambiguous after
 * that cannot be told apart, and are left out.
 */
function addressable(items: LibraryItem[]): { item: LibraryItem; name: string }[] {
  const key = (n: string) => n.trim().toLowerCase();
  const count = (list: { name: string }[]) => {
    const m = new Map<string, number>();
    for (const { name } of list) m.set(key(name), (m.get(key(name)) ?? 0) + 1);
    return m;
  };
  const named = items.filter((i) => i.name?.trim() && live(i).length).map((item) => ({ item, name: item.name!.trim() }));
  const shared = count(named);
  const named2 = named.map(({ item, name }) => {
    if (shared.get(key(name))! < 2) return { item, name };
    const texts = live(item)
      .filter((e) => e.type === "text")
      .map((e) => String(e.originalText ?? e.text ?? "").replace(/\s+/g, " ").trim())
      .filter((t) => [...t].length > 1); // drop letter-by-letter logos ("G", "o", "o", ...)
    const label = [...new Set(texts)].join(" / ");
    // Cut by code point, so an emoji is never split in half.
    return { item, name: label ? `${name}: ${[...label].slice(0, 60).join("")}` : name };
  });
  const unique = count(named2);
  return named2.filter(({ name }) => unique.get(key(name)) === 1);
}

// What agents search for, mapped to what the packs call it. Tried only when the
// words themselves match nothing.
const ALIASES: Record<string, string[]> = {
  queue: ["sqs", "mq", "message q"],
  "message queue": ["sqs", "mq", "message q"],
  bucket: ["s3"],
  "object storage": ["s3", "object storage"],
  function: ["lambda"],
  serverless: ["lambda"],
  cdn: ["cloudfront", "cdn"],
  user: ["client", "computer"],
  users: ["client", "computer"],
  person: ["client", "computer"],
  browser: ["client", "computer"],
  laptop: ["client", "computer"],
  mobile: ["mobile"],
  nosql: ["dynamodb", "document db"],
  cache: ["elasticache", "cache"],
  redis: ["elasticache", "cache"],
  "load balancer": ["elb", "alb", "nlb"],
  dns: ["route 53", "dns"],
  container: ["ecs", "eks", "fargate"],
  kubernetes: ["eks", "kubernetes"],
  postgres: ["rds", "aurora", "relational db"],
  mysql: ["rds", "aurora", "relational db"],
  sql: ["rds", "aurora", "relational db"],
  vpc: ["vpc"],
  stream: ["kinesis", "msk"],
  kafka: ["msk"],
  notification: ["sns"],
  pubsub: ["sns", "eventbridge"],
  auth: ["cognito", "iam", "auth"],
  secrets: ["secrets manager"],
  monitoring: ["cloudwatch"],
  logs: ["cloudwatch"],
  email: ["ses"],
  search: ["opensearch", "cloudsearch"],
  warehouse: ["redshift"],
};

const SHOW_SIZES_UP_TO = 40;

/**
 * Items for one query: every word must appear in the name; a name that is the
 * query (after its "Pack: " prefix) or contains it as a phrase comes first.
 * When nothing matches, known aliases are tried ("queue" finds "AWS: SQS").
 */
export function searchLibrary(items: LibraryItem[], query = "") {
  const named = addressable(items);
  const match = (q: string) => {
    const phrase = q.toLowerCase().trim();
    const words = phrase.split(/\s+/).filter(Boolean);
    const rank = (name: string) => {
      const n = name.toLowerCase();
      const bare = n.slice(n.indexOf(":") + 1).trim();
      return bare === phrase ? 0 : n.includes(phrase) ? 1 : 2;
    };
    return named.filter((i) => words.every((w) => i.name.toLowerCase().includes(w))).sort((a, b) => rank(a.name) - rank(b.name));
  };
  let hits = match(query);
  let via: string | null = null;
  const aliases = ALIASES[query.toLowerCase().trim()];
  if (hits.length === 0 && aliases) {
    hits = [...new Set(aliases.flatMap(match))];
    via = aliases.join(", ");
  }
  return {
    total: hits.length,
    via,
    items: hits.map(({ item, name }) => {
      if (hits.length > SHOW_SIZES_UP_TO) return { name };
      const b = bounds(live(item));
      return { name, width: Math.round(b.width), height: Math.round(b.height) };
    }),
  };
}

/** Exact name (any case) first, else the only item containing the name. */
export function findItem(items: LibraryItem[], name: string): LibraryItem & { name: string } {
  const wanted = name.trim().toLowerCase();
  const named = addressable(items);
  const exact = named.filter((i) => i.name.toLowerCase() === wanted);
  if (exact.length) return { ...exact[0].item, name: exact[0].name };
  const partial = named.filter((i) => i.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return { ...partial[0].item, name: partial[0].name };
  const hint = partial.length
    ? `"${name}" matches ${partial.length} items, e.g. ${partial
        .slice(0, 6)
        .map((i) => `"${i.name}"`)
        .join(", ")}; use the full name`
    : `no library item is named "${name}"; use search_library to find names`;
  throw new Error(hint);
}

/**
 * Copy an item to (x, y) (its top-left corner). `label` replaces the item's own
 * caption when it has exactly one free-standing text, else is added underneath.
 * `size` resizes the main element only: right for group boxes like "AWS: Region",
 * whose icon and title sit in the top-left corner.
 */
export function placeItem(
  item: LibraryItem,
  at: { x: number; y: number },
  mainId: string,
  label?: string,
  size: { width?: number; height?: number } = {},
): Element[] {
  const source = live(item);
  const main = [...source].sort((a, b) => {
    const rank = (e: Element) => (BINDABLE.has(e.type) ? 1 : 0);
    return rank(b) - rank(a) || (b.width as number) * (b.height as number) - (a.width as number) * (a.height as number);
  })[0];
  const ids = new Map(source.map((e) => [e.id, e === main ? mainId : newId()]));
  const groups = new Map<string, string>();
  const group = (g: string) => groups.get(g) ?? (groups.set(g, newId()), groups.get(g)!);
  const placement = newId();
  const b = bounds(source);
  const dx = at.x - b.x;
  const dy = at.y - b.y;
  const remap = (binding: unknown) => {
    const id = (binding as { elementId?: string } | null)?.elementId;
    return id && ids.has(id) ? { ...(binding as object), elementId: ids.get(id) } : null;
  };
  const now = Date.now();

  const placed = source.map((e): Element => {
    const refs = (e.boundElements as { id: string; type: string }[] | null) ?? [];
    return {
      ...e,
      id: ids.get(e.id)!,
      x: (e.x as number) + dx,
      y: (e.y as number) + dy,
      groupIds: [...((e.groupIds as string[] | undefined) ?? []).map(group), placement],
      frameId: null,
      containerId: typeof e.containerId === "string" ? (ids.get(e.containerId) ?? null) : (e.containerId ?? null),
      boundElements: refs.filter((r) => ids.has(r.id)).map((r) => ({ ...r, id: ids.get(r.id)! })),
      ...("startBinding" in e ? { startBinding: remap(e.startBinding) } : {}),
      ...("endBinding" in e ? { endBinding: remap(e.endBinding) } : {}),
      customData: { ...(e.customData as object | undefined), library: item.name ?? item.id, ...(e === main ? { libraryMain: true } : {}) },
      version: 1,
      versionNonce: randomInt(2 ** 31),
      seed: typeof e.seed === "number" ? e.seed : randomInt(2 ** 31),
      isDeleted: false,
      updated: now,
      index: null,
      locked: false,
    };
  });

  const placedMain = placed.find((e) => e.id === mainId)!;
  if (size.width) placedMain.width = size.width;
  if (size.height) placedMain.height = size.height;

  if (label !== undefined) {
    const captions = placed.filter((e) => e.type === "text" && !e.containerId);
    if (captions.length === 1) {
      const t = captions[0];
      const width = Math.max(label.length * (t.fontSize as number) * 0.6, 1);
      Object.assign(t, { text: label, originalText: label, x: (t.x as number) + (t.width as number) / 2 - width / 2, width });
    } else {
      const pb = bounds(placed);
      const width = label.length * 16 * 0.6;
      placed.push({
        id: newId(),
        type: "text",
        x: pb.x + pb.width / 2 - width / 2,
        y: pb.y + pb.height + 6,
        width,
        height: 20,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [placement],
        frameId: null,
        index: null,
        roundness: null,
        seed: randomInt(2 ** 31),
        version: 1,
        versionNonce: randomInt(2 ** 31),
        isDeleted: false,
        boundElements: null,
        updated: now,
        link: null,
        locked: false,
        text: label,
        originalText: label,
        fontSize: 16,
        fontFamily: 5,
        textAlign: "center",
        verticalAlign: "top",
        containerId: null,
        autoResize: true,
        lineHeight: 1.25,
        customData: { library: item.name ?? item.id },
      });
    }
  }
  return placed;
}

/** The outermost group of a placement: the one placeItem added. */
export const placementGroup = (e: Element) => {
  const g = e.groupIds as string[] | undefined;
  return e.customData && (e.customData as { library?: string }).library && g?.length ? g[g.length - 1] : null;
};
