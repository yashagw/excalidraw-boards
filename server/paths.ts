// Board and folder ids are relative paths like "Work/Architecture" (no extension).
// The file for that board is <boards dir>/Work/Architecture.excalidraw.
import { HttpError } from "./errors.ts";

export const BOARD_EXT = ".excalidraw";

const BAD_CHARS = /[\\:*?"<>|\u0000-\u001f\u007f]/;
const MAX_SEGMENT = 120;

/** Normalise a board or folder id, or throw 400. Accepts "a/b", "/a/b/", "a/b.excalidraw". */
export function cleanId(input: unknown, what = "name"): string {
  if (typeof input !== "string") throw new HttpError(400, `${what} must be a string`);
  let value = input.trim();
  if (value.toLowerCase().endsWith(BOARD_EXT)) value = value.slice(0, -BOARD_EXT.length);
  const segments = value
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) throw new HttpError(400, `${what} is empty`);
  for (const s of segments) {
    if (s.startsWith(".")) throw new HttpError(400, `${what}: "${s}" cannot start with a dot`);
    if (BAD_CHARS.test(s)) throw new HttpError(400, `${what}: "${s}" contains one of \\ : * ? " < > |`);
    if (s.length > MAX_SEGMENT) throw new HttpError(400, `${what}: "${s.slice(0, 20)}…" is longer than ${MAX_SEGMENT} characters`);
  }
  return segments.join("/");
}

/** Like cleanId, but "" (or missing) is the top level. */
export function cleanFolder(input: unknown): string {
  if (input === undefined || input === null || (typeof input === "string" && input.trim().replace(/\//g, "") === "")) {
    return "";
  }
  return cleanId(input, "folder");
}

export const parentOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
export const nameOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
export const joinId = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
