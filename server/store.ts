// Boards are plain .excalidraw files in nested folders. Every write goes through
// one queue, so a browser save, an MCP edit and a move can never interleave.
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.ts";
import { BOARD_EXT, parentOf } from "./paths.ts";
import { type Element, type Scene, emptyScene, mergeElements, parseScene, prune, serializeScene } from "./scene.ts";

export type Kind = "board" | "folder";

export type StoreEvent =
  | { type: "board"; id: string; etag: string; by: string; focus?: string[] }
  | { type: "tree" }
  | { type: "moved"; kind: Kind; from: string; to: string }
  | { type: "deleted"; kind: Kind; id: string };

export type Tree = {
  folders: string[];
  boards: { id: string; updated: number; size: number }[];
};

export type SaveInput = {
  elements: Element[];
  appState?: Record<string, unknown>;
  files?: Scene["files"];
};

// Before a board is overwritten, its previous version is copied to history/<board>/,
// at most once per SNAPSHOT_EVERY_MS, keeping the newest HISTORY_KEEP. A safety net
// for a bad write: restore by copying a snapshot back over the board.
const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;
const HISTORY_KEEP = 50;

const etagOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export class Store {
  readonly events = new EventEmitter();
  readonly boardsDir: string;
  readonly trashDir: string;
  readonly libraryFile: string;
  readonly historyDir: string;
  readonly source: string;
  private queue: Promise<unknown> = Promise.resolve();
  private lastSnapshot = new Map<string, number>();

  constructor(dataDir: string, source: string) {
    this.boardsDir = path.join(dataDir, "boards");
    this.trashDir = path.join(dataDir, "trash");
    this.historyDir = path.join(dataDir, "history");
    this.libraryFile = path.join(dataDir, "library.excalidrawlib");
    this.source = source;
    this.events.setMaxListeners(0);
  }

  async init() {
    await fs.mkdir(this.boardsDir, { recursive: true });
    await fs.mkdir(this.trashDir, { recursive: true });
  }

  private file(id: string) {
    return path.join(this.boardsDir, ...id.split("/")) + BOARD_EXT;
  }

  private dir(id: string) {
    return id ? path.join(this.boardsDir, ...id.split("/")) : this.boardsDir;
  }

  private emit(event: StoreEvent) {
    this.events.emit("event", event);
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => {});
    return run;
  }

  private async snapshot(id: string) {
    const now = Date.now();
    if (now - (this.lastSnapshot.get(id) ?? 0) < SNAPSHOT_EVERY_MS) return;
    const dir = path.join(this.historyDir, ...id.split("/"));
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(this.file(id), path.join(dir, `${new Date(now).toISOString().replace(/[:.]/g, "-")}${BOARD_EXT}`));
      this.lastSnapshot.set(id, now);
      const old = (await fs.readdir(dir)).filter((f) => f.endsWith(BOARD_EXT)).sort();
      for (const f of old.slice(0, -HISTORY_KEEP)) await fs.rm(path.join(dir, f));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`history snapshot of "${id}" failed:`, err);
    }
  }

  async tree(): Promise<Tree> {
    const tree: Tree = { folders: [], boards: [] };
    const walk = async (dirId: string) => {
      const entries = await fs.readdir(this.dir(dirId), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const id = dirId ? `${dirId}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          tree.folders.push(id);
          await walk(id);
        } else if (entry.isFile() && entry.name.endsWith(BOARD_EXT)) {
          const stat = await fs.stat(path.join(this.dir(dirId), entry.name));
          tree.boards.push({ id: id.slice(0, -BOARD_EXT.length), updated: stat.mtimeMs, size: stat.size });
        }
      }
    };
    await walk("");
    return tree;
  }

  async exists(id: string): Promise<boolean> {
    return fs.stat(this.file(id)).then(
      (s) => s.isFile(),
      () => false,
    );
  }

  async read(id: string): Promise<{ scene: Scene; etag: string }> {
    let text: string;
    try {
      text = await fs.readFile(this.file(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `no board "${id}"`);
      throw err;
    }
    return { scene: parseScene(text), etag: etagOf(text) };
  }

  private async write(id: string, scene: Scene): Promise<string> {
    const text = serializeScene(scene);
    const target = this.file(id);
    await this.snapshot(id);
    // Write a hidden temp file next to the target, then rename: a reader sees the old file or the new one, never half.
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, target);
    return etagOf(text);
  }

  create(id: string, by: string, scene: Scene = emptyScene(this.source)): Promise<{ etag: string }> {
    return this.serial(async () => {
      if (await this.exists(id)) throw new HttpError(409, `a board named "${id}" already exists`);
      await fs.mkdir(this.dir(parentOf(id)), { recursive: true });
      const etag = await this.write(id, scene);
      this.emit({ type: "tree" });
      this.emit({ type: "board", id, etag, by });
      return { etag };
    });
  }

  /** A browser save, merged per element. Returns the merged scene when it differs from what the browser sent. */
  save(id: string, input: SaveInput, by: string): Promise<{ etag: string; merged: Scene | null }> {
    return this.serial(async () => {
      const current = await this.read(id);
      const { elements, tookStored } = mergeElements(current.scene.elements, input.elements);
      const next = prune({
        ...current.scene,
        source: this.source,
        elements,
        appState: input.appState ?? current.scene.appState,
        files: { ...current.scene.files, ...input.files },
      });
      const etag = await this.write(id, next);
      if (etag !== current.etag) this.emit({ type: "board", id, etag, by });
      return { etag, merged: tookStored ? next : null };
    });
  }

  /** A read-modify-write of one board (the MCP tools use this). */
  update<T>(
    id: string,
    by: string,
    edit: (scene: Scene) => Promise<{ scene: Scene; result: T; focus?: string[] }>,
  ): Promise<{ etag: string; scene: Scene; result: T }> {
    return this.serial(async () => {
      const current = await this.read(id);
      const { scene, result, focus } = await edit(current.scene);
      const next = prune({ ...scene, source: this.source });
      const etag = await this.write(id, next);
      if (etag !== current.etag) this.emit({ type: "board", id, etag, by, focus });
      return { etag, scene: next, result };
    });
  }

  createFolder(id: string): Promise<void> {
    return this.serial(async () => {
      const dir = this.dir(id);
      const exists = await fs.stat(dir).then(
        () => true,
        () => false,
      );
      if (exists) throw new HttpError(409, `a folder named "${id}" already exists`);
      await fs.mkdir(dir, { recursive: true });
      this.emit({ type: "tree" });
    });
  }

  move(kind: Kind, from: string, to: string): Promise<void> {
    return this.serial(async () => {
      if (from === to) return;
      if (kind === "folder" && (to + "/").startsWith(from + "/")) {
        throw new HttpError(400, "a folder cannot be moved into itself");
      }
      const src = kind === "board" ? this.file(from) : this.dir(from);
      const dst = kind === "board" ? this.file(to) : this.dir(to);
      await fs.stat(src).catch(() => {
        throw new HttpError(404, `no ${kind} "${from}"`);
      });
      const taken = await fs.stat(dst).then(
        () => true,
        () => false,
      );
      // On a case-insensitive disk (macOS) a rename that only changes case finds itself.
      if (taken && from.toLowerCase() !== to.toLowerCase()) {
        throw new HttpError(409, `a ${kind} named "${to}" already exists`);
      }
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      this.emit({ type: "moved", kind, from, to });
      this.emit({ type: "tree" });
    });
  }

  /** Deleting moves the board or folder into trash/, named with the time it was deleted. */
  remove(kind: Kind, id: string): Promise<void> {
    return this.serial(async () => {
      const src = kind === "board" ? this.file(id) : this.dir(id);
      await fs.stat(src).catch(() => {
        throw new HttpError(404, `no ${kind} "${id}"`);
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `${stamp} ${id.replaceAll("/", " ∕ ")}${kind === "board" ? BOARD_EXT : ""}`;
      await fs.rename(src, path.join(this.trashDir, name));
      this.emit({ type: "deleted", kind, id });
      this.emit({ type: "tree" });
    });
  }

  async readLibrary(): Promise<unknown[]> {
    try {
      const data = JSON.parse(await fs.readFile(this.libraryFile, "utf8"));
      return Array.isArray(data.libraryItems) ? data.libraryItems : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  writeLibrary(libraryItems: unknown[]): Promise<void> {
    return this.serial(async () => {
      const text = JSON.stringify({ type: "excalidrawlib", version: 2, source: this.source, libraryItems }, null, 2);
      const tmp = `${this.libraryFile}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, this.libraryFile);
    });
  }
}
