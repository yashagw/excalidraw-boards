// Worker thread: runs Excalidraw's own convertToExcalidrawElements, so elements
// drawn through the MCP get real labels and arrow bindings, exactly as the editor
// makes them. See convert.ts for the main-thread side.
import { parentPort } from "node:worker_threads";
import "./dom-shim.ts";
import { lineWidth } from "./geometry.ts";

const { convertToExcalidrawElements, setCustomTextMetricsProvider } = await import("@excalidraw/excalidraw");

// Font strings look like "20px Excalifont, Xiaolai, Segoe UI Emoji".
setCustomTextMetricsProvider({ getLineWidth: (text: string, font: string) => lineWidth(text, parseFloat(font) || 20) });

parentPort!.on("message", ({ id, skeletons }: { id: number; skeletons: unknown[] }) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const elements = convertToExcalidrawElements(skeletons as any, { regenerateIds: false });
    parentPort!.postMessage({ id, ok: true, elements });
  } catch (err) {
    parentPort!.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
