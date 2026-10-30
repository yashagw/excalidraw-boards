// Main-thread side of convert-worker.ts. One worker, started on first use and
// restarted if it dies.
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Element } from "./scene.ts";

export type Convert = (skeletons: Record<string, unknown>[]) => Promise<Element[]>;

const TIMEOUT_MS = 20_000;

type Pending = { resolve: (els: Element[]) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

export function createConverter(workerFile = path.join(import.meta.dirname, "convert-worker.js")): Convert {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, Pending>();

  const failAll = (err: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
    worker = null;
  };

  const start = () => {
    const w = new Worker(workerFile);
    w.on("message", (msg: { id: number; ok: boolean; elements?: Element[]; error?: string }) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.elements!);
      else p.reject(new Error(msg.error));
    });
    // "exit" follows "error"; only the current worker may fail the queue.
    w.on("error", (err) => worker === w && failAll(err));
    w.on("exit", (code) => worker === w && failAll(new Error(`converter worker exited (${code})`)));
    w.unref();
    return w;
  };

  return (skeletons) =>
    new Promise((resolve, reject) => {
      worker ??= start();
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("converter timed out"));
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, skeletons });
    });
}
