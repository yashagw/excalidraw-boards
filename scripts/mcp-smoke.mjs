// Smoke test against a running server: node scripts/mcp-smoke.mjs http://localhost:3779/mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(process.argv[2])));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`--- ${name}${r.isError ? " (ERROR)" : ""}\n${r.content[0].text.slice(0, 900)}`);
  return r;
};
console.log((await client.listTools()).tools.map((t) => t.name).join(", "));
await call("create_board", { board: "Work/Architecture", elements: [
  { type: "text", id: "t", x: 160, y: 30, text: "Order service", fontSize: 28 },
  { type: "rectangle", id: "web", x: 60, y: 110, width: 180, height: 80, roundness: { type: 3 }, backgroundColor: "#a5d8ff", label: "Web app" },
  { type: "rectangle", id: "api", x: 340, y: 110, width: 180, height: 80, roundness: { type: 3 }, backgroundColor: "#d0bfff", label: "Orders API" },
  { type: "ellipse", id: "db", x: 360, y: 280, width: 140, height: 90, backgroundColor: "#c3fae8", label: "Postgres" },
  { type: "arrow", id: "a1", start: { id: "web" }, end: { id: "api" }, label: "REST" },
  { type: "arrow", id: "a2", start: { id: "api" }, end: { id: "db" }, label: "SQL" },
]});
await call("add_elements", { board: "Work/Architecture", elements: [
  { type: "diamond", id: "cache", x: 640, y: 110, width: 160, height: 100, label: "Redis" },
  { type: "arrow", id: "a3", startBinding: { elementId: "api", fixedPoint: [1, 0.5] }, endBinding: { elementId: "cache", fixedPoint: [0, 0.5] }, strokeStyle: "dashed" },
]});
await call("add_elements", { board: "Work/Architecture", elements: [{ type: "rectangle", id: "web", x: 0, y: 0 }] });
await call("update_elements", { board: "Work/Architecture", updates: [{ id: "db", dx: 200 }, { id: "api", label: "Orders API v2", backgroundColor: "#ffd8a8" }, { id: "web", bogus: 1 }] });
await call("delete_elements", { board: "Work/Architecture", ids: ["cache"] });
await call("read_board", { board: "Work/Architecture" });
await call("move_board", { from: "Work/Architecture", to: "Work/Systems/Orders" });
await call("list_boards");
await call("read_board", { board: "Nope" });
await client.close();
