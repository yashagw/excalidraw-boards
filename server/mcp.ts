// The MCP server: tools that let an agent list, read and draw on boards.
// Served statelessly at POST /mcp (Streamable HTTP); one McpServer per request.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Convert } from "./convert.ts";
import { ELEMENT_TYPES, ToolError, UPDATE_KEYS, addElements, deleteElements, describe, updateElements } from "./edit.ts";
import { HttpError } from "./errors.ts";
import { normalizeItems, searchLibrary } from "./library.ts";
import { DRAWING_GUIDE, INSTRUCTIONS } from "./guide.ts";
import { cleanId, nameOf } from "./paths.ts";
import type { Element } from "./scene.ts";
import type { Store, Tree } from "./store.ts";

const BY = "mcp";

const board = z.string().describe('Board name as a path, e.g. "Work/Architecture" (board "Architecture" in folder "Work")');
const elements = z
  .array(z.looseObject({ type: z.enum(ELEMENT_TYPES), id: z.string().optional() }))
  .describe(
    'Excalidraw elements: rectangle, ellipse, diamond, text, arrow, line, frame, or { "type": "library", "name": ... } for an icon from the user\'s library. Call drawing_guide for the format.',
  );

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

/** Mistakes in the input go back to the agent as a tool error it can act on. */
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolError || err instanceof HttpError) return { isError: true, content: [{ type: "text", text: err.message }] };
    throw err;
  }
}

function treeText(tree: Tree): string {
  if (tree.boards.length === 0 && tree.folders.length === 0) return "No boards yet. Use create_board.";
  const lines: string[] = [`${tree.boards.length} boards, ${tree.folders.length} folders:`];
  const ids = [...tree.folders.map((f) => ({ id: f, folder: true })), ...tree.boards.map((b) => ({ id: b.id, folder: false }))];
  ids.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }) || Number(b.folder) - Number(a.folder));
  const updated = new Map(tree.boards.map((b) => [b.id, new Date(b.updated).toISOString().slice(0, 16).replace("T", " ")]));
  for (const { id, folder } of ids) {
    const depth = id.split("/").length - 1;
    lines.push(`${"  ".repeat(depth)}${nameOf(id)}${folder ? "/" : `   (${id}, updated ${updated.get(id)} UTC)`}`);
  }
  return lines.join("\n");
}

/** The ids an agent gave: not label texts, and only the main element of a library icon. */
const named = (els: Element[], ids: string[]) => {
  const set = new Set(ids);
  const part = (e: Element) => (e.customData as { library?: string; libraryMain?: boolean } | undefined)?.library && !(e.customData as { libraryMain?: boolean }).libraryMain;
  return els.filter((e) => set.has(e.id) && !(e.type === "text" && e.containerId) && !part(e)).map((e) => e.id);
};

export function createMcpServer(store: Store, convert: Convert, boardUrl: (id: string) => string): McpServer {
  const server = new McpServer({ name: "excalidraw-boards", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const library = async () => normalizeItems(await store.readLibrary());

  server.registerTool(
    "drawing_guide",
    {
      title: "Drawing guide",
      description: "The element format, colour palette, sizing rules and an example. Call once before your first drawing.",
      annotations: { readOnlyHint: true },
    },
    async () => text(DRAWING_GUIDE),
  );

  server.registerTool(
    "list_boards",
    {
      title: "List boards",
      description: "All boards and folders, as a tree.",
      annotations: { readOnlyHint: true },
    },
    () => run(async () => text(treeText(await store.tree()))),
  );

  server.registerTool(
    "search_library",
    {
      title: "Search the icon library",
      description:
        'Find icons in the user\'s Excalidraw library, to place with { "type": "library", "name": ... } in add_elements. Pass every icon you need at once, e.g. queries: ["cloudfront", "api gateway", "lambda", "s3", "queue", "users"]. Common words work ("queue" finds SQS, "bucket" S3, "users" a client computer). Returns exact names and sizes. An empty query lists every name. What is there depends on the packs the user added (for example AWS architecture icons or system design components).',
      inputSchema: {
        queries: z.array(z.string()).optional().describe("Several searches in one call; each is words that must all appear in the name"),
        query: z.string().optional().describe("One search; empty lists every name"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ queries, query }) =>
      run(async () => {
        const items = await library();
        const list = queries?.length ? queries : [query ?? ""];
        const blocks = list.map((q) => {
          const r = searchLibrary(items, q);
          const head = q ? `"${q}"` : "all items";
          if (r.total === 0) return `${head}: no match; try a shorter or different word.`;
          const via = r.via ? ` (via ${r.via})` : "";
          const names = r.items.map((i) => ("width" in i ? `${i.name} (${i.width}×${i.height})` : i.name));
          return `${head}${via}: ${r.total} match${r.total === 1 ? "" : "es"}\n${names.join(r.items.length > 40 ? "; " : "\n")}`;
        });
        return text(blocks.join("\n\n"));
      }),
  );

  server.registerTool(
    "read_board",
    {
      title: "Read a board",
      description:
        "What is on a board: each element's id, type, position, size, text/label, arrow ends and any non-default style, plus the bounds of everything. Labels are shown on their shape, not as separate text elements.",
      inputSchema: { board },
      annotations: { readOnlyHint: true },
    },
    ({ board }) =>
      run(async () => {
        const id = cleanId(board, "board");
        const { scene } = await store.read(id);
        const { count, bounds, elements } = describe(scene);
        const head = JSON.stringify({ board: id, url: boardUrl(id), count, bounds });
        return text(`${head.slice(0, -1)},"elements":[\n${elements.map((e) => JSON.stringify(e)).join(",\n")}\n]}`);
      }),
  );

  server.registerTool(
    "create_board",
    {
      title: "Create a board",
      description: "Create a new board (folders in the name are created as needed), optionally with elements to draw on it.",
      inputSchema: { board, elements: elements.optional() },
    },
    ({ board, elements }) =>
      run(async () => {
        const id = cleanId(board, "board");
        await store.create(id, BY);
        let summary = "empty";
        if (elements?.length) {
          const { result } = await store.update(id, BY, async (scene) => {
            const r = await addElements(scene, elements, convert, library);
            return { scene: r.scene, result: named(r.scene.elements, r.ids), focus: r.ids };
          });
          summary = `${result.length} elements: ${result.join(", ")}`;
        }
        return text(`Created board "${id}" (${summary}).\nURL: ${boardUrl(id)}`);
      }),
  );

  server.registerTool(
    "add_elements",
    {
      title: "Draw on a board",
      description:
        'Add elements to an existing board, on top of what is there. Shapes take a "label"; arrows take "start"/"end" ({ "id": ... }) and are routed and bound for you. { "type": "library", "name": "Lambda", "id": "fn", "x": 0, "y": 0 } places a library icon (find names with search_library); arrows can bind to it by id. Ids must be new on the board. See drawing_guide.',
      inputSchema: { board, elements },
    },
    ({ board, elements }) =>
      run(async () => {
        const id = cleanId(board, "board");
        const { result } = await store.update(id, BY, async (scene) => {
          const r = await addElements(scene, elements, convert, library);
          return { scene: r.scene, result: named(r.scene.elements, r.ids), focus: r.ids };
        });
        return text(`Added ${result.length} elements to "${id}": ${result.join(", ")}.\nURL: ${boardUrl(id)}`);
      }),
  );

  server.registerTool(
    "update_elements",
    {
      title: "Change elements",
      description:
        'Change existing elements by id. Each update is { "id", ...fields } with fields from: x, y, dx, dy (move by), width, height, text (text elements), label (shape or arrow text; "" removes it), fontSize, textAlign, points, strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness, opacity, roundness, angle, link, locked, startArrowhead, endArrowhead. Labels and bound arrows follow moved shapes.',
      inputSchema: {
        board,
        updates: z.array(z.looseObject({ id: z.string() })).describe(`Updates; allowed fields: ${UPDATE_KEYS.join(", ")}`),
      },
    },
    ({ board, updates }) =>
      run(async () => {
        const id = cleanId(board, "board");
        const { result } = await store.update(id, BY, async (scene) => {
          const r = updateElements(scene, updates);
          return { scene: r.scene, result: r, focus: r.ids };
        });
        const warn = result.warnings.length ? `\nWarnings: ${result.warnings.join("; ")}` : "";
        return text(`Updated ${result.ids.length} elements on "${id}".${warn}\nURL: ${boardUrl(id)}`);
      }),
  );

  server.registerTool(
    "delete_elements",
    {
      title: "Delete elements",
      description: "Delete elements by id. Their labels go with them; arrows bound to a deleted shape stay but are unbound.",
      inputSchema: { board, ids: z.array(z.string()).describe("Element ids") },
      annotations: { destructiveHint: true },
    },
    ({ board, ids }) =>
      run(async () => {
        const id = cleanId(board, "board");
        const { result } = await store.update(id, BY, async (scene) => {
          const r = deleteElements(scene, ids);
          return { scene: r.scene, result: r.ids };
        });
        return text(`Deleted ${result.length} elements (labels included) from "${id}".\nURL: ${boardUrl(id)}`);
      }),
  );

  server.registerTool(
    "move_board",
    {
      title: "Rename or move a board",
      description: 'Rename a board or move it to another folder, e.g. from "Untitled" to "Work/Architecture".',
      inputSchema: { from: board, to: board },
    },
    ({ from, to }) =>
      run(async () => {
        const src = cleanId(from, "from");
        const dst = cleanId(to, "to");
        await store.move("board", src, dst);
        return text(`Moved "${src}" to "${dst}".\nURL: ${boardUrl(dst)}`);
      }),
  );

  return server;
}
