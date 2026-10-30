# Development

```sh
npm install
npm run dev     # UI on http://localhost:5173 (hot reload), API and MCP on :3779, boards in ./data
npm test        # unit tests (run `npm run build` once first: some use the built converter)
npm run typecheck
```

`node scripts/mcp-smoke.mjs http://localhost:3779/mcp` runs every MCP tool against
a running server (it creates a board under `Work/`).

## How it fits together

```
browser ── Vite + React app (src/)
   │        <Excalidraw> from @excalidraw/excalidraw, plus the Boards sidebar
   │        session.ts: autosave, merge, live updates for the open board
   │
   │  /api/*        board files, tree, moves, trash, library
   │  /api/events   server-sent events: board changed, tree changed, moved, deleted
   │  /mcp          MCP tools for agents
   ▼
Node server (server/)
   store.ts      files on disk, one write queue, history, events
   scene.ts      the .excalidraw format and the per-element merge
   edit.ts       what the MCP tools do to a board
   library.ts    placing library items for agents
   convert-*.ts  Excalidraw's convertToExcalidrawElements, run in a worker thread
```

- The editor is the published `@excalidraw/excalidraw` package. It is not forked
  or patched; upgrading is a version bump in `package.json`.
- The server is bundled by Vite (`vite.server.config.ts`), because Node cannot
  import the Excalidraw package as published. Express, the MCP SDK and zod stay
  external.
- Excalidraw's converter needs a few browser globals; `dom-shim.ts` provides them
  inside a worker thread only, so the HTTP server never sees a fake `window`.

`CLAUDE.md` lists the rules the code relies on (merging, closing a board's
session, z-order, events). Read it before changing `session.ts`, `scene.ts` or
`store.ts`.

## Checking a UI change

The editor draws on a canvas, so only a real browser shows layout problems. After
any change to `session.ts` or `App.tsx`, switch between boards that have content
(with the pointer moving) and check that the board files did not change.

## Releasing an image

`make release REGISTRY=registry.example.com` builds a linux/arm64 image and pushes
it as `<registry>/excalidraw-boards:<commit>` and `:latest`. Put
`REGISTRY := …` in `local.mk` (git-ignored) to make it the default.
