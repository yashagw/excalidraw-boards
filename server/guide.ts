// The drawing reference the `drawing_guide` tool returns. The palette, element
// format and sizing rules are adapted from the official Excalidraw MCP
// (github.com/excalidraw/excalidraw-mcp, MIT), so drawings look the same as there.
// The camera, checkpoint and animation parts do not apply here and are left out.
export const DRAWING_GUIDE = `# Drawing on Excalidraw boards

Boards are real Excalidraw drawings saved on the server. Your elements are added to the board the user has (or will have) open in their browser; an open board updates live and pans to what you add.

## Workflow
1. \`list_boards\` to see what exists. Board names are paths: "Work/Architecture" is board "Architecture" in folder "Work".
2. Adding to an existing board: \`read_board\` first. Place new content beside the existing \`bounds\` (to the right or below), never on top of it.
3. \`create_board\` (optionally with elements) or \`add_elements\` to draw. Send a whole diagram in one call when you can.
4. \`update_elements\` to move, restyle or relabel; \`delete_elements\` to remove. Labels and bound arrows follow their shapes.
5. Give the user the board URL from the tool result.

## Elements
Required: \`type\`, \`x\`, \`y\` (scene coordinates, y grows downward). Give every element an \`id\` you can refer to later (unique on the board; ids are never reused, even after a delete).
Defaults (leave out): strokeColor "#1e1e1e", backgroundColor "transparent", fillStyle "solid", strokeWidth 2, strokeStyle "solid", roughness 1, opacity 100.

**rectangle / ellipse / diamond**: \`{ "type": "rectangle", "id": "api", "x": 100, "y": 100, "width": 200, "height": 80 }\`
- \`"roundness": { "type": 3 }\` for rounded corners
- \`"backgroundColor": "#a5d8ff"\` to fill
- \`"label": { "text": "API server", "fontSize": 20 }\` (or just \`"label": "API server"\`) puts centred text inside. PREFER this over separate text elements.
- Label text is dark (#1e1e1e) by default; \`"label": { "text": "...", "strokeColor": "#15803d" }\` colours it.

**text** (titles, notes): \`{ "type": "text", "id": "title", "x": 100, "y": 40, "text": "Checkout flow", "fontSize": 28 }\`
- x is the LEFT edge. Width ≈ characters × fontSize × 0.55; to centre over cx, use x = cx − width/2.
- "\\n" makes a new line.

**arrow / line between shapes (PREFERRED)**: \`{ "type": "arrow", "id": "a1", "start": { "id": "api" }, "end": { "id": "db" }, "label": "SQL" }\`
- No coordinates needed: the server routes it edge to edge and binds it, so it follows the shapes when they move.
- \`"startBinding": { "elementId": "api", "fixedPoint": [1, 0.5] }\` also works and pins the end to a point on the shape: top [0.5,0], bottom [0.5,1], left [0,0.5], right [1,0.5].
- \`endArrowhead\`: "arrow" (default for arrows) | "triangle" | "bar" | "dot" | null; \`startArrowhead\` likewise.
- \`"strokeStyle": "dashed"\` for optional or async flows.

**free arrow / line**: \`{ "type": "arrow", "id": "a2", "x": 300, "y": 150, "points": [[0,0],[150,0]] }\` — points are offsets from x,y; add middle points for bends.

**library icon** (AWS services, system design parts, logos: whatever packs the user added to their library):
\`{ "type": "library", "id": "fn", "name": "Lambda", "x": 300, "y": 120 }\`
- \`search_library\` with all your icons at once (\`"queries": ["cloudfront", "lambda", "s3", "queue", "users"]\`) returns exact names and sizes. Use the names exactly as returned. x, y is the icon's top-left corner; it keeps its own size.
- \`"label": "Orders fn"\` replaces the icon's caption (most service icons have one under them).
- Arrows bind to it by id like any shape: \`{ "type": "arrow", "start": { "id": "fn" }, "end": { "id": "db" } }\`.
- Service icons are usually about 65×65 plus a caption: space them 150–200px apart.
- Group boxes (in the AWS pack: "AWS Cloud", "Region", "AWS account", "Auto Scaling group", …) go behind the icons, so add them first, sized with \`width\`/\`height\` to wrap what goes inside. Without a fitting box, use a dashed rectangle (\`"strokeStyle": "dashed"\`, no fill) with a text title at its top-left.
- In \`read_board\` an icon is one entry, \`"type": "library"\`; move, relabel or delete it by that id.
- If search_library finds nothing, the user has no such pack: draw with plain shapes instead.

**frame** (a titled group): \`{ "type": "frame", "id": "f1", "name": "Backend", "children": ["api", "db"] }\` — draws a frame around the children.

## Colours
Strokes: blue #4a9eed, amber #f59e0b, green #22c55e, red #ef4444, purple #8b5cf6, pink #ec4899, cyan #06b6d4.
Fills (pastel): light blue #a5d8ff (inputs, primary), light green #b2f2bb (success, output), light orange #ffd8a8 (external, pending), light purple #d0bfff (processing), light red #ffc9c9 (errors), light yellow #fff3bf (notes, decisions), light teal #c3fae8 (storage, data), light pink #eebefa (metrics).
Zones behind groups: #dbe4ff, #e5dbff, #d3f9d8 with "opacity": 30.
Text on white must be dark: never lighter than #757575. Coloured text on a pastel fill: use the dark variant (#15803d not #22c55e, #2563eb not #4a9eed).

## Sizing and layout
- Labelled shapes at least 120×60; fontSize 16–20 for labels, 24–32 for titles, never below 14.
- Leave 60–80px between shapes joined by a plain arrow and 120–160px when the arrow has a label; keep arrow labels to a word or two.
- Lay flows out left→right or top→bottom on a grid (for example columns 250px apart, rows 150px apart).
- Array order is z-order: zones and frames first, then shapes, then arrows.
- No emoji: Excalidraw's hand-drawn font does not have them.

## Example: two services and a database
\`\`\`json
[
  { "type": "text", "id": "t", "x": 200, "y": 30, "text": "Order service", "fontSize": 28 },
  { "type": "rectangle", "id": "web", "x": 60, "y": 110, "width": 180, "height": 80, "roundness": { "type": 3 }, "backgroundColor": "#a5d8ff", "label": "Web app" },
  { "type": "rectangle", "id": "api", "x": 380, "y": 110, "width": 180, "height": 80, "roundness": { "type": 3 }, "backgroundColor": "#d0bfff", "label": "Orders API" },
  { "type": "ellipse", "id": "db", "x": 400, "y": 310, "width": 140, "height": 90, "backgroundColor": "#c3fae8", "label": "Postgres" },
  { "type": "arrow", "id": "a1", "start": { "id": "web" }, "end": { "id": "api" }, "label": "REST" },
  { "type": "arrow", "id": "a2", "start": { "id": "api" }, "end": { "id": "db" }, "label": "SQL" }
]
\`\`\`
`;

export const INSTRUCTIONS = `Excalidraw boards: hand-drawn diagrams saved as files in folders on the user's own server. Call drawing_guide once before your first drawing. Use list_boards / read_board to see what exists, create_board or add_elements to draw, update_elements and delete_elements to change a board. For AWS or system design diagrams, search_library finds real icons to place. Every result includes the board URL; give it to the user. A board that is open in the browser updates live.`;
