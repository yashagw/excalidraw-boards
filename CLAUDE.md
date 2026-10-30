# excalidraw-boards

Excalidraw with boards in folders saved on the server, plus an MCP endpoint for
agents. README.md is the user-facing summary; docs/ has the details.

Built on the published `@excalidraw/excalidraw` package on purpose, not on a
fork of the excalidraw repo or a third-party wrapper: an upgrade is a version
bump. Do not vendor or patch the package.

## Layout

- `src/` — the web app (Vite + React). `App.tsx` mounts `<Excalidraw>` once per
  open board (`key={session.key}`), with the Boards sidebar (`BoardsPanel.tsx`).
  `session.ts` is all sync logic for one open board.
- `server/` — Express. `store.ts` (files, one write queue, events, history), `scene.ts`
  (file format, merge), `edit.ts` (what MCP tools do to a scene), `library.ts`
  (placing library icons for agents), `mcp.ts` (tool definitions), `guide.ts`
  (the drawing guide agents read), `index.ts` (routes).
- `server/convert-worker.ts` runs Excalidraw's own `convertToExcalidrawElements`
  in a worker thread, with `dom-shim.ts` faking just enough browser. The shim
  must never load in the main thread: Express and the MCP SDK would see a fake
  `window`. Node cannot import the package as published (a JSON import without
  an import attribute), so the server is bundled by `vite.server.config.ts`.

## Invariants

- **A board is a plain `.excalidraw` file.** Keep it openable on excalidraw.com:
  standard top-level shape, no extra fields. Ids are paths without the extension.
- **Merging is per element**, Excalidraw's rule: higher `version` wins, then
  lower `versionNonce`. Every change to an element must bump both (`bump()` in
  scene.ts). Deletes are tombstones (`isDeleted: true`) kept for 7 days.
- **A save never removes an element by leaving it out.** Every save is merged
  (`mergeElements`); only a newer tombstone deletes. This is the guard against
  the 0.1.4 data loss: a board the user had just left saved its unmounted,
  empty editor over three boards. Do not reintroduce a "take the save as-is"
  path. As a consequence "Open" (replace the scene from a file) is not in the
  menu: it would merge, not replace.
- **A left board is closed** (`BoardSession.close()`, called in `open()` while
  the old editor is still mounted). A closed session never reads its editor,
  saves from it, or reports status.
- **History**: before overwriting a board the store copies the old file to
  `$DATA_DIR/history/<board>/<time>.excalidraw`, at most every 10 minutes,
  newest 50 kept. Restore = copy one back over the board.
- **z-order is the fractional `index`.** Server-added elements get keys above the
  board's highest (`fractional-indexing`, the same library Excalidraw uses).
- **Events**: `board` (with `by` = tab id or `mcp`, and `focus` ids for agent
  edits), `tree`, `moved`, `deleted`, over SSE at `/api/events`. A tab ignores
  its own `board` events.
- Server-side text sizes are estimates (`geometry.ts`), tuned wide. Rendering is
  still correct: Excalidraw positions text from x/y and alignment.
- **Library icons for agents**: `{ "type": "library", "name": "AWS: Lambda" }` in
  add_elements copies the item from the user's library (`library.excalidrawlib`)
  with fresh ids into one group; the largest shape takes the agent's id and
  `customData.libraryMain`, every part gets `customData.library`. Move, relabel
  and delete act on the whole icon; read_board shows it as one entry. Items of
  packs without per-item names are named from their own text.

## Checks

`npm run typecheck`, `npm test` (after `npm run build`: the converter tests use
the built worker), and `node scripts/mcp-smoke.mjs <url>/mcp` against a server.
UI changes: look at it in a browser; the editor is canvas-based and only a real
render shows layout problems. After any change to session.ts or App.tsx, switch
between boards that have content (with the pointer moving) and check the
board files afterwards: that is how the 0.1.4 data loss would have been caught.
