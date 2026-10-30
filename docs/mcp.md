# MCP: let an agent draw

The server speaks the [Model Context Protocol](https://modelcontextprotocol.io)
at `/mcp` (Streamable HTTP, stateless). An agent can list your boards, read one,
draw on it, change it and organise boards, all in the same files the editor
uses. If the board is open in a browser, it updates live, and the view moves to
what the agent added when that is off screen.

## Connect a client

Use the URL you open the app at, plus `/mcp`.

**Claude Code**

```sh
claude mcp add --transport http excalidraw http://localhost:3779/mcp
# add --scope user to have it in every project
```

**Cursor** (`~/.cursor/mcp.json`) and most clients that use the `mcpServers` shape:

```json
{
  "mcpServers": {
    "excalidraw": { "url": "http://localhost:3779/mcp" }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "excalidraw": { "type": "http", "url": "http://localhost:3779/mcp" }
  }
}
```

The client must be able to reach the server. Desktop and CLI clients on the same
machine or private network can. Web-based connectors that call MCP servers from
the vendor's cloud (claude.ai, for example) cannot reach a server on `localhost`
or a private network.

Set `PUBLIC_URL` to the address you open the app at, so the board links in tool
results work and that host name is accepted (see
[self-hosting](self-hosting.md#configuration)).

## Tools

| Tool | Input | What it does |
|---|---|---|
| `drawing_guide` | none | The element format, colour palette, sizing rules and an example. Agents read it once before drawing |
| `list_boards` | none | Every folder and board, as a tree |
| `read_board` | `board` | Each element's id, type, position, size, label, arrow ends and non-default style, plus the bounds of everything |
| `create_board` | `board`, `elements?` | A new board (folders are created as needed), optionally drawn on at once |
| `add_elements` | `board`, `elements` | Draw on an existing board, on top of what is there |
| `update_elements` | `board`, `updates` | Change elements by id: move (`x`, `y`, `dx`, `dy`), resize, `label`, `text`, colours and style. Labels and attached arrows follow |
| `delete_elements` | `board`, `ids` | Remove elements; their labels go with them, attached arrows stay but come loose |
| `search_library` | `queries` | Find library items by name to place as icons |
| `move_board` | `from`, `to` | Rename a board or move it to another folder |

A board is named by its path: `"Work/Architecture"` is the board *Architecture*
in the folder *Work*. Every result includes the board's URL.

## The element format

Elements are [Excalidraw elements](https://docs.excalidraw.com/docs/codebase/json-schema),
with the boring fields filled in for you. The format matches the official
[Excalidraw MCP](https://github.com/excalidraw/excalidraw-mcp), so prompts and
habits carry over.

```json
[
  { "type": "text", "id": "title", "x": 120, "y": 0, "text": "Checkout flow", "fontSize": 28 },
  { "type": "rectangle", "id": "web", "x": 0, "y": 80, "width": 170, "height": 80,
    "roundness": { "type": 3 }, "backgroundColor": "#a5d8ff", "label": "Web app" },
  { "type": "rectangle", "id": "api", "x": 320, "y": 80, "width": 180, "height": 80,
    "backgroundColor": "#d0bfff", "label": { "text": "Orders API", "fontSize": 20 } },
  { "type": "arrow", "id": "a1", "start": { "id": "web" }, "end": { "id": "api" }, "label": "POST /orders" }
]
```

- **Types:** `rectangle`, `ellipse`, `diamond`, `text`, `arrow`, `line`, `frame`,
  and `library` (below).
- **Labels:** `label` on a shape or arrow puts centred text inside or on it. It is
  dark by default; `"label": { "text": "…", "strokeColor": "#15803d" }` colours it.
- **Arrows:** give `start` and `end` as `{ "id": … }` and the server routes the
  arrow edge to edge and binds it, so it follows the shapes when they move.
  `startBinding: { "elementId": …, "fixedPoint": [1, 0.5] }` (the official MCP's
  form) pins an end to a point on the shape. A free arrow takes `x`, `y` and
  `points` instead.
- **Ids** are yours to choose and must be new on the board, even after a delete.
- Labels and arrows go through Excalidraw's own `convertToExcalidrawElements`,
  so the result is exactly what the editor would have made.

## Library icons

Agents can place items from your [library](boards.md#the-library), such as AWS
service icons:

```json
[
  { "type": "library", "id": "fn", "name": "Lambda", "x": 0, "y": 0, "label": "Resize images" },
  { "type": "library", "id": "bucket", "name": "S3", "x": 220, "y": 0 },
  { "type": "arrow", "start": { "id": "fn" }, "end": { "id": "bucket" }, "label": "thumbnails" }
]
```

`search_library` turns words into exact names (`"queue"` also finds *SQS*,
`"users"` a client computer), and takes several queries at once. A placed icon
moves, relabels and deletes as one piece, and `read_board` lists it as one entry.
Group boxes such as *AWS Cloud* or *Region* take `width` and `height` to wrap the
icons inside them.

What is available depends on which packs you added; with none, agents draw with
plain shapes.

## Tips for prompts

- Name the board: *"…on a new board Architecture/Payments"*. Without a name the
  agent picks one.
- Ask for changes the way you would ask a person: *"move the cache under the API
  and make the queue dashed"*. Agents use `read_board` to find the ids.
- Agents that draw a whole diagram in one `create_board` or `add_elements` call
  are fastest; the drawing guide tells them so.
