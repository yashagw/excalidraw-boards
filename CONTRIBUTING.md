# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

For anything bigger than a small fix, open an issue first so we can agree on the
approach. It saves you from writing code that does not fit.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Set up and run it ([docs/development.md](docs/development.md)):

   ```sh
   npm install
   npm run dev
   ```

3. Make your change, with tests where it makes sense (`test/`).
4. Check it:

   ```sh
   npm run typecheck
   npm run build && npm test
   ```

   If you touched the editor or saving (`src/session.ts`, `src/App.tsx`), switch
   between boards that have content and check that the board files on disk did
   not change. If you touched the MCP tools, run
   `node scripts/mcp-smoke.mjs http://localhost:3779/mcp`.

5. Open a pull request against `main` and fill in the template.

## How pull requests are merged

- `main` is protected: nobody pushes to it directly, including the maintainer.
  Every change goes through a pull request.
- CI must pass: the `test` job (typecheck, build, unit tests) and the `docker` job
  (the image builds, starts and answers on the app, API and MCP endpoints).
  Workflows from first-time contributors start after a maintainer approves them.
- Review comments must be resolved before merging.
- Pull requests are squash-merged, so `main` has one commit per change with a
  linear history. Write the PR title as you would a commit subject.

## Things to keep in mind

- The editor is the published `@excalidraw/excalidraw` package. Please do not
  vendor or patch it; changes belong in this app around it.
- Boards are plain `.excalidraw` files and must stay openable on excalidraw.com.
- `CLAUDE.md` lists the rules the code relies on (merging, history, z-order).
  Read it before changing `session.ts`, `scene.ts` or `store.ts`.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
