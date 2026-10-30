// The flat {folders, boards} list from the API as a nested, sorted tree.
import { type Tree, nameOf, parentOf } from "./api";

export type BoardNode = { id: string; name: string; updated: number };
export type FolderNode = { id: string; name: string; folders: FolderNode[]; boards: BoardNode[]; count: number };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name);

export function buildTree(tree: Tree): FolderNode {
  const root: FolderNode = { id: "", name: "", folders: [], boards: [], count: 0 };
  const folders = new Map<string, FolderNode>([["", root]]);
  const folder = (id: string): FolderNode => {
    let node = folders.get(id);
    if (!node) {
      node = { id, name: nameOf(id), folders: [], boards: [], count: 0 };
      folders.set(id, node);
      folder(parentOf(id)).folders.push(node);
    }
    return node;
  };
  for (const id of tree.folders) folder(id);
  for (const b of tree.boards) folder(parentOf(b.id)).boards.push({ id: b.id, name: nameOf(b.id), updated: b.updated });
  const finish = (node: FolderNode): number => {
    node.folders.sort(byName);
    node.boards.sort(byName);
    node.count = node.boards.length + node.folders.reduce((n, f) => n + finish(f), 0);
    return node.count;
  };
  finish(root);
  return root;
}

/** A name like "Untitled", "Untitled 2", ... that is free in `taken`. */
export function freeName(base: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}
