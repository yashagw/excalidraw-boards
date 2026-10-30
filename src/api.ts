// The board API (server/index.ts), as typed fetch calls.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFileData } from "@excalidraw/excalidraw/types";

export type Kind = "board" | "folder";

export type Tree = {
  folders: string[];
  boards: { id: string; updated: number; size: number }[];
};

export type StoredScene = {
  type: "excalidraw";
  elements: ExcalidrawElement[];
  appState: Partial<AppState>;
  files: Record<string, BinaryFileData>;
};

export type ServerEvent =
  | { type: "board"; id: string; etag: string; by: string; focus?: string[] }
  | { type: "tree" }
  | { type: "moved"; kind: Kind; from: string; to: string }
  | { type: "deleted"; kind: Kind; id: string };

/** Identifies this tab, so it can ignore the change events its own saves cause. */
export const CLIENT_ID = Math.random().toString(36).slice(2, 12);

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "X-Client-Id": CLIENT_ID, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const q = (id: string) => encodeURIComponent(id);

export const api = {
  tree: () => call<Tree>("GET", "/api/tree"),
  board: (id: string) => call<{ etag: string; scene: StoredScene }>("GET", `/api/board?id=${q(id)}`),
  save: (id: string, body: { elements: readonly ExcalidrawElement[]; appState: Partial<AppState>; files: Record<string, BinaryFileData> }) =>
    call<{ etag: string; merged: StoredScene | null }>("PUT", `/api/board?id=${q(id)}`, body),
  createBoard: (folder: string, name: string) => call<{ id: string; etag: string }>("POST", "/api/boards", { folder, name }),
  createFolder: (folder: string, name: string) => call<{ id: string }>("POST", "/api/folders", { folder, name }),
  move: (kind: Kind, from: string, to: string) => call<{ id: string }>("POST", "/api/move", { kind, from, to }),
  remove: (kind: Kind, id: string) => call<void>("DELETE", `/api/entry?kind=${kind}&id=${q(id)}`),
  library: () => call<{ libraryItems: unknown[] }>("GET", "/api/library"),
  saveLibrary: (libraryItems: unknown) => call<void>("PUT", "/api/library", { libraryItems }),
};

export const parentOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
export const nameOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
export const joinId = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
export const boardPath = (id: string) => `/b/${id.split("/").map(encodeURIComponent).join("/")}`;
