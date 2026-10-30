// Server build: one bundle for the HTTP server and one for the converter worker.
// @excalidraw/excalidraw and its dependencies are bundled in (Node cannot load the
// package as published); Express, the MCP SDK, zod and compression stay external.
import { defineConfig } from "vite";

const EXTERNAL = ["express", "@modelcontextprotocol/sdk", "zod", "compression"];

export default defineConfig({
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  ssr: { noExternal: true, external: EXTERNAL },
  logLevel: "warn",
  build: {
    ssr: true,
    target: "node22",
    outDir: "dist/server",
    emptyOutDir: true,
    copyPublicDir: false,
    rolldownOptions: {
      input: { index: "server/index.ts", "convert-worker": "server/convert-worker.ts" },
      external: (id) => EXTERNAL.some((name) => id === name || id.startsWith(`${name}/`)),
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" },
      onLog(level, log, handler) {
        if (log.code === "MODULE_LEVEL_DIRECTIVE") return; // "use client" in React libraries
        handler(level, log);
      },
    },
  },
});
