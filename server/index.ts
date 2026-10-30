// HTTP server: the built web app, the board API, live updates (SSE) and the MCP endpoint.
import fs from "node:fs";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import compression from "compression";
import express, { type NextFunction, type Request, type Response } from "express";
import { createConverter } from "./convert.ts";
import { HttpError } from "./errors.ts";
import { createMcpServer } from "./mcp.ts";
import { cleanFolder, cleanId, joinId } from "./paths.ts";
import { isElementList } from "./scene.ts";
import { type Kind, Store, type StoreEvent } from "./store.ts";

const PORT = Number(process.env.PORT ?? 3779);
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "data");
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
const CLIENT_DIR = path.join(import.meta.dirname, "..", "client");

const store = new Store(DATA_DIR, PUBLIC_URL);
await store.init();
const convert = createConverter();
const boardUrl = (id: string) => `${PUBLIC_URL}/b/${id.split("/").map(encodeURIComponent).join("/")}`;

const app = express();
app.disable("x-powered-by");
// Compress everything except the event stream, which must reach the browser unbuffered.
app.use(compression({ filter: (req, res) => req.path !== "/api/events" && compression.filter(req, res) }));

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const clientId = (req: Request) => String(req.get("x-client-id") ?? "unknown").slice(0, 64);
const kindOf = (value: unknown): Kind => {
  if (value !== "board" && value !== "folder") throw new HttpError(400, 'kind must be "board" or "folder"');
  return value;
};

const api = express.Router();
api.use(express.json({ limit: "64mb" }));

api.get("/tree", route(async (_req, res) => res.json(await store.tree())));

api.get(
  "/board",
  route(async (req, res) => {
    const { scene, etag } = await store.read(cleanId(req.query.id, "board"));
    res.set("Cache-Control", "no-store").json({ etag, scene });
  }),
);

api.put(
  "/board",
  route(async (req, res) => {
    const id = cleanId(req.query.id, "board");
    const { elements, appState, files } = req.body ?? {};
    if (!isElementList(elements)) throw new HttpError(400, "elements must be a list of Excalidraw elements");
    const result = await store.save(id, { elements, appState, files }, clientId(req));
    res.json(result);
  }),
);

api.post(
  "/boards",
  route(async (req, res) => {
    const id = joinId(cleanFolder(req.body?.folder), cleanId(req.body?.name, "name"));
    const { etag } = await store.create(id, clientId(req));
    res.status(201).json({ id, etag });
  }),
);

api.post(
  "/folders",
  route(async (req, res) => {
    const id = joinId(cleanFolder(req.body?.folder), cleanId(req.body?.name, "name"));
    await store.createFolder(id);
    res.status(201).json({ id });
  }),
);

api.post(
  "/move",
  route(async (req, res) => {
    const kind = kindOf(req.body?.kind);
    const from = cleanId(req.body?.from, "from");
    const to = cleanId(req.body?.to, "to");
    await store.move(kind, from, to);
    res.json({ id: to });
  }),
);

api.delete(
  "/entry",
  route(async (req, res) => {
    await store.remove(kindOf(req.query.kind), cleanId(req.query.id, "id"));
    res.status(204).end();
  }),
);

api.get("/library", route(async (_req, res) => res.json({ libraryItems: await store.readLibrary() })));

api.put(
  "/library",
  route(async (req, res) => {
    const items = req.body?.libraryItems;
    if (!Array.isArray(items)) throw new HttpError(400, "libraryItems must be a list");
    await store.writeLibrary(items);
    res.status(204).end();
  }),
);

// Live updates for open tabs: board changes, tree changes, moves and deletes.
api.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const send = (event: StoreEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  store.events.on("event", send);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    store.events.off("event", send);
  });
});

api.use((_req, _res, next) => next(new HttpError(404, "no such API")));
app.use("/api", api);

// MCP, stateless: a fresh server and transport per request.
app.post(
  "/mcp",
  express.json({ limit: "16mb" }),
  route(async (req, res) => {
    const server = createMcpServer(store, convert, boardUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }),
);
app.all("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

app.get("/healthz", (_req, res) => res.send("ok"));

// The web app. Hashed assets and fonts never change; index.html must always be fresh.
if (fs.existsSync(CLIENT_DIR)) {
  app.use(
    express.static(CLIENT_DIR, {
      index: false,
      setHeaders: (res, file) => {
        const rel = path.relative(CLIENT_DIR, file);
        if (rel.startsWith("assets") || rel.startsWith("fonts")) res.set("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.get(/^\/(?!api\/|mcp$).*/, (_req, res) => {
    res.set("Cache-Control", "no-cache").sendFile(path.join(CLIENT_DIR, "index.html"));
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const status = (err as { status?: number; type?: string }).status;
  if (status && status < 500) {
    res.status(status).json({ error: (err as Error).message }); // e.g. body too large, bad JSON
    return;
  }
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

app.listen(PORT, () => {
  console.log(`excalidraw-boards on :${PORT}, data in ${DATA_DIR}, public URL ${PUBLIC_URL}`);
});
