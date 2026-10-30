// One open board: loads it, autosaves edits, and folds in changes made by the
// MCP or by another tab. All network work runs through one queue, in order.
//
// Saves send every element, deleted ones included, with the etag of the version
// they started from; the server merges by element version (Excalidraw's own rule),
// so neither side's changes are lost. See server/scene.ts mergeElements.
import {
  CaptureUpdateAction,
  getCommonBounds,
  hashElementsVersion,
  reconcileElements,
  restore,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFileData, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { ApiError, type StoredScene, api } from "./api";

export type SaveStatus = "saved" | "unsaved" | "saving" | "offline" | "gone" | "error";

const SAVE_DELAY_MS = 500; // after the last change...
const SAVE_MAX_WAIT_MS = 3000; // ...but never later than this after the first unsaved one

/** Excalidraw's --right-sidebar-width. A docked sidebar covers this much of the canvas. */
export const SIDEBAR_PX = 302;
const VIEW_PADDING_PX = 80; // room for the toolbar and the corner buttons
const MIN_CONTEXT_ZOOM = 0.4; // below this, keeping the old view in sight is not worth it

/** The part of appState that belongs to the board (background colour, grid), as Excalidraw's own export keeps it. */
const boardAppState = (appState: AppState): Partial<AppState> => JSON.parse(serializeAsJSON([], appState, {}, "local")).appState;

/**
 * Zoom and scroll that show `elements` in the part of the canvas a docked sidebar
 * leaves free, never zoomed in past 100%. Excalidraw's own scrollToContent centres
 * on the whole window, so content ends up under the sidebar.
 */
function viewFor(elements: readonly ExcalidrawElement[], sidebarPx: number): Pick<AppState, "zoom" | "scrollX" | "scrollY"> | null {
  const live = elements.filter((e) => !e.isDeleted);
  if (live.length === 0) return null;
  const [minX, minY, maxX, maxY] = getCommonBounds(live);
  const width = window.innerWidth - sidebarPx;
  const height = window.innerHeight;
  const fit = Math.min(1, (width - 2 * VIEW_PADDING_PX) / Math.max(1, maxX - minX), (height - 2 * VIEW_PADDING_PX) / Math.max(1, maxY - minY));
  const zoom = Math.max(0.1, fit);
  return {
    zoom: { value: zoom as AppState["zoom"]["value"] },
    scrollX: width / 2 / zoom - (minX + maxX) / 2,
    scrollY: height / 2 / zoom - (minY + maxY) / 2,
  };
}

/** The scene area on screen (left of a docked sidebar), inset by `padding` screen pixels. */
function visibleArea(appState: AppState, sidebarPx: number, padding: number) {
  const z = appState.zoom.value;
  return {
    left: -appState.scrollX + padding / z,
    top: -appState.scrollY + padding / z,
    right: -appState.scrollX + (appState.width - sidebarPx - padding) / z,
    bottom: -appState.scrollY + (appState.height - padding) / z,
  };
}

/**
 * Where to look after an agent adds `targets`: nowhere new if they are already in
 * comfortable view; else what was on screen plus them; or, if that would zoom out
 * too far (they are far away), just them.
 */
function viewAfterAgent(
  targets: readonly ExcalidrawElement[],
  all: readonly ExcalidrawElement[],
  appState: AppState,
  sidebarPx: number,
): ReturnType<typeof viewFor> {
  const [minX, minY, maxX, maxY] = getCommonBounds(targets);
  const comfy = visibleArea(appState, sidebarPx, VIEW_PADDING_PX);
  if (minX >= comfy.left && minY >= comfy.top && maxX <= comfy.right && maxY <= comfy.bottom) return null;
  const screen = visibleArea(appState, sidebarPx, 0);
  const onScreen = all.filter((e) => {
    const [x1, y1, x2, y2] = getCommonBounds([e]);
    return x2 > screen.left && x1 < screen.right && y2 > screen.top && y1 < screen.bottom;
  });
  const both = viewFor([...onScreen, ...targets], sidebarPx);
  return both && both.zoom.value >= MIN_CONTEXT_ZOOM ? both : viewFor(targets, sidebarPx);
}

const dockedSidebarPx = () => (document.querySelector(".excalidraw .sidebar--docked") ? SIDEBAR_PX : 0);

type Snapshot = {
  elements: readonly ExcalidrawElement[];
  hash: number;
  appState: Partial<AppState>;
  appStateKey: string;
  files: BinaryFileData[];
};

let nextKey = 1;

export class BoardSession {
  /** Changes when the board is renamed or moved; `key` does not. */
  id: string;
  readonly key = nextKey++;
  status: SaveStatus = "saved";
  error = "";
  private excalidraw: ExcalidrawImperativeAPI | null = null;
  private etag: string;
  private loaded: StoredScene;
  private initial: ExcalidrawInitialDataState | null = null;
  private savedHash = 0;
  private savedAppState = "";
  private savedFiles: Set<string>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstChangeAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private retryMs = 1000;
  /** Set once the board is left. Its editor unmounts and then reports an empty
   *  scene, so from here on nothing may read it, save from it or show status. */
  private closed = false;
  private onStatus: (status: SaveStatus) => void;

  constructor(id: string, loaded: { etag: string; scene: StoredScene }, onStatus: (status: SaveStatus) => void) {
    this.id = id;
    this.etag = loaded.etag;
    this.loaded = loaded.scene;
    this.savedFiles = new Set(Object.keys(loaded.scene.files ?? {}));
    this.onStatus = onStatus;
  }

  /** `sidebarPx`: how much of the canvas the docked sidebar will cover (0 if none). */
  initialData(appState: Partial<AppState>, sidebarPx: number): ExcalidrawInitialDataState {
    if (!this.initial) {
      const data = restore(this.loaded, null, null, { repairBindings: true });
      this.savedHash = hashElementsVersion(data.elements);
      this.savedAppState = JSON.stringify(boardAppState(data.appState as AppState));
      const view = viewFor(data.elements, sidebarPx);
      this.initial = { elements: data.elements, appState: { ...data.appState, ...appState, ...view }, files: data.files, scrollToContent: !view };
    }
    return this.initial;
  }

  attach(excalidraw: ExcalidrawImperativeAPI) {
    this.excalidraw = excalidraw;
  }

  private setStatus(status: SaveStatus, error = "") {
    if (this.closed) return; // the badge belongs to the next board now
    this.status = status;
    this.error = error;
    this.onStatus(status);
  }

  private enqueue(op: () => Promise<void>) {
    this.queue = this.queue.then(op).catch((err) => console.error(err));
  }

  /** Call on every Excalidraw onChange (it fires on pointer moves too, so this only arms a timer). */
  changed() {
    if (this.closed) return;
    const now = Date.now();
    if (this.timer === undefined) this.firstChangeAt = now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(SAVE_DELAY_MS, this.firstChangeAt + SAVE_MAX_WAIT_MS - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.isDirty()) {
        if (this.status === "saved") this.setStatus("unsaved");
        this.enqueue(() => this.save());
      }
    }, wait);
  }

  private unsavedFiles(): BinaryFileData[] {
    const x = this.excalidraw!;
    const files = x.getFiles();
    const out: BinaryFileData[] = [];
    for (const el of x.getSceneElementsIncludingDeleted()) {
      const fileId = "fileId" in el ? el.fileId : null;
      if (fileId && !this.savedFiles.has(fileId) && files[fileId]) out.push(files[fileId]);
    }
    return out;
  }

  isDirty(): boolean {
    return this.snapshot() !== null;
  }

  hasPendingChanges() {
    return this.timer !== undefined || this.status === "saving" || this.isDirty();
  }

  /** What a save would send now, read from the live editor; null if nothing changed. */
  private snapshot(): Snapshot | null {
    const x = this.excalidraw;
    if (!x || this.closed || this.status === "gone") return null;
    const elements = x.getSceneElementsIncludingDeleted();
    const hash = hashElementsVersion(elements);
    const appState = boardAppState(x.getAppState());
    const appStateKey = JSON.stringify(appState);
    const files = this.unsavedFiles();
    if (hash === this.savedHash && appStateKey === this.savedAppState && files.length === 0) return null;
    return { elements, hash, appState, appStateKey, files };
  }

  private async save() {
    const snap = this.snapshot();
    if (snap) await this.send(snap);
    else if (this.status === "unsaved") this.setStatus("saved");
  }

  private async send(snap: Snapshot) {
    this.setStatus("saving");
    try {
      const res = await api.save(this.id, {
        elements: snap.elements,
        appState: snap.appState,
        files: Object.fromEntries(snap.files.map((f) => [f.id, f])),
      });
      this.etag = res.etag;
      this.savedHash = snap.hash;
      this.savedAppState = snap.appStateKey;
      for (const f of snap.files) this.savedFiles.add(f.id);
      this.retryMs = 1000;
      if (res.merged) this.apply(res.merged);
      this.setStatus("saved");
      if (this.isDirty()) this.changed();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        this.setStatus("gone");
      } else if (err instanceof ApiError && err.status < 500) {
        this.setStatus("error", err.message); // retrying the same request would fail the same way
      } else {
        this.setStatus("offline");
        // A closed board retries what it captured; an open one saves its latest state.
        setTimeout(() => this.enqueue(() => (this.closed ? this.send(snap) : this.save())), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 30_000);
      }
    }
  }

  /** Fold a version from the server into the editor, keeping local edits that are newer. */
  private apply(remote: StoredScene, focus?: string[]) {
    const x = this.excalidraw;
    if (!x || this.closed) return;
    const local = x.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[];
    const wasClean = hashElementsVersion(local) === this.savedHash;
    const files = Object.values(remote.files ?? {});
    if (files.length) {
      x.addFiles(files);
      for (const f of files) this.savedFiles.add(f.id);
    }
    const incoming = restoreElements(remote.elements, null, { repairBindings: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merged = reconcileElements(local, incoming as any, x.getAppState());
    x.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    // With no local edits pending, the editor now holds exactly the server's version.
    if (wasClean) this.savedHash = hashElementsVersion(x.getSceneElementsIncludingDeleted());
    if (focus?.length) {
      const ids = new Set(focus);
      const all = x.getSceneElements();
      const targets = all.filter((e) => ids.has(e.id));
      const view = targets.length ? viewAfterAgent(targets, all, x.getAppState(), dockedSidebarPx()) : null;
      if (view) x.updateScene({ appState: view, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }

  /** Someone else changed this board (an agent, or another tab). */
  remoteChanged(etag: string, focus?: string[]) {
    this.enqueue(async () => {
      if (etag === this.etag || this.status === "gone" || !this.excalidraw || this.closed) return;
      try {
        const fresh = await api.board(this.id);
        this.apply(fresh.scene, focus);
        this.etag = fresh.etag;
        if (this.isDirty()) this.changed();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) this.setStatus("gone");
        else throw err;
      }
    });
  }

  /** The board was renamed or moved on the server. */
  rename(id: string) {
    this.id = id;
    if (this.status === "gone") {
      this.setStatus("unsaved");
      this.changed();
    }
  }

  /** Save anything pending now, and wait for it. */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.isDirty()) this.enqueue(() => this.save());
    return this.queue;
  }

  /**
   * Leave this board. Call while its editor is still mounted: the last changes
   * are read now and saved in the background, and the editor is never read again.
   */
  close(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const last = this.snapshot();
    this.closed = true;
    this.excalidraw = null;
    if (last) this.enqueue(() => this.send(last));
    return this.queue;
  }
}
