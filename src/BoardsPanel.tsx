// The "Boards" sidebar: folders and boards as a tree. Click to open, double-click
// to rename, drag onto a folder to move, ⋯ or right-click for everything else.
import { type DragEvent, type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Kind, type Tree, nameOf, parentOf } from "./api";
import { BoardIcon, ChevronIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, MoreIcon, MoveIcon, PencilIcon, PlusIcon, SearchIcon, TrashIcon } from "./icons";
import { type FolderNode, buildTree, freeName } from "./tree";

export type BoardActions = {
  open(id: string): void;
  createBoard(folder: string, name: string): Promise<void>;
  createFolder(folder: string, name: string): Promise<void>;
  rename(kind: Kind, id: string, name: string): Promise<void>;
  move(kind: Kind, id: string, folder: string): Promise<void>;
  remove(kind: Kind, id: string): Promise<void>;
};

type Props = {
  tree: Tree;
  currentId: string | null;
  expanded: ReadonlySet<string>;
  onExpand(id: string, open: boolean): void;
  filter: string;
  onFilter(value: string): void;
  /** Scroll position of the list, kept by the caller: the panel remounts with every board. */
  scroll: { current: number };
  actions: BoardActions;
};

type Entry = { kind: Kind; id: string };
type Draft = { kind: Kind; folder: string; initial: string };
type Menu = { entry: Entry; x: number; y: number; view: "main" | "move" };

// dataTransfer cannot be read during dragover, so the dragged entry lives here.
let dragged: Entry | null = null;

const indent = (depth: number) => 6 + depth * 14;

function canMove(entry: Entry | null, folder: string): entry is Entry {
  if (!entry || parentOf(entry.id) === folder) return false;
  return !(entry.kind === "folder" && (folder + "/").startsWith(entry.id + "/"));
}

function findFolder(root: FolderNode, id: string): FolderNode {
  if (!id) return root;
  for (const f of root.folders) {
    if (f.id === id) return f;
    if (id.startsWith(f.id + "/")) return findFolder(f, id);
  }
  return root;
}

function NameInput({ depth, icon, initial, onDone }: { depth: number; icon: ReactNode; initial: string; onDone(name: string): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string) => {
    if (done.current) return;
    done.current = true;
    onDone(value.trim());
  };
  return (
    <div className="bp-row is-editing" style={{ paddingLeft: indent(depth) }}>
      <span className="bp-chevron" />
      <span className="bp-icon">{icon}</span>
      <input
        ref={ref}
        className="bp-input"
        defaultValue={initial}
        aria-label="Name"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(e.currentTarget.value);
          if (e.key === "Escape") finish("");
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  );
}

function EntryMenu({ menu, root, host, close, onView, onCreate, onRename, actions }: {
  menu: Menu;
  root: FolderNode;
  host: Element;
  close(): void;
  onView(view: Menu["view"]): void;
  onCreate(kind: Kind, folder: string): void;
  onRename(entry: Entry): void;
  actions: BoardActions;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  const { entry } = menu;

  useLayoutEffect(() => {
    const box = ref.current!.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(menu.x, innerWidth - box.width - 8)), top: Math.max(8, Math.min(menu.y, innerHeight - box.height - 8)) });
  }, [menu.x, menu.y, menu.view]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("pointerdown", onDown, true);
    addEventListener("keydown", onKey, true);
    addEventListener("resize", close);
    return () => {
      removeEventListener("pointerdown", onDown, true);
      removeEventListener("keydown", onKey, true);
      removeEventListener("resize", close);
    };
  }, [close]);

  const item = (icon: ReactNode, label: string, run: () => void, className = "") => (
    <button type="button" className={className} onClick={run}>
      {icon}
      <span>{label}</span>
    </button>
  );

  let body: ReactNode;
  if (menu.view === "move") {
    const targets: { id: string; depth: number }[] = [{ id: "", depth: 0 }];
    const walk = (node: FolderNode, depth: number) => node.folders.forEach((f) => (targets.push({ id: f.id, depth }), walk(f, depth + 1)));
    walk(root, 1);
    body = (
      <>
        <div className="bp-menu-title">Move “{nameOf(entry.id)}” to</div>
        <div className="bp-menu-scroll">
          {targets.map((t) => (
            <button
              type="button"
              key={t.id || "/"}
              disabled={!canMove(entry, t.id)}
              style={{ paddingLeft: 8 + t.depth * 14 }}
              onClick={() => (close(), void actions.move(entry.kind, entry.id, t.id))}
            >
              {FolderIcon}
              <span>{t.id ? nameOf(t.id) : "Top level"}</span>
            </button>
          ))}
        </div>
      </>
    );
  } else {
    body = (
      <>
        {entry.kind === "folder" && item(PlusIcon, "New board here", () => onCreate("board", entry.id))}
        {entry.kind === "folder" && item(FolderPlusIcon, "New folder here", () => onCreate("folder", entry.id))}
        {item(PencilIcon, "Rename", () => (close(), onRename(entry)))}
        {item(MoveIcon, "Move to…", () => onView("move"))}
        <div className="bp-menu-sep" />
        {item(TrashIcon, "Move to trash", () => (close(), void actions.remove(entry.kind, entry.id)), "danger")}
      </>
    );
  }
  return createPortal(
    <div ref={ref} className="bp-menu" style={pos} role="menu">
      {body}
    </div>,
    host,
  );
}

export function BoardsPanel({ tree, currentId, expanded, onExpand, filter, onFilter, scroll, actions }: Props) {
  const root = useMemo(() => buildTree(tree), [tree]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [renaming, setRenaming] = useState<Entry | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Back to where the list was before the board changed, before the first paint, then
  // make sure the open board is in view.
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = scroll.current;
  }, [scroll]);
  useEffect(() => {
    panel.current?.querySelector(".bp-row.is-active")?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  const startCreate = (kind: Kind, folder: string) => {
    setMenu(null);
    onFilter("");
    if (folder) onExpand(folder, true);
    const node = findFolder(root, folder);
    const taken = kind === "board" ? node.boards.map((b) => b.name) : node.folders.map((f) => f.name);
    setDraft({ kind, folder, initial: freeName(kind === "board" ? "Untitled" : "New folder", taken) });
  };

  const commitDraft = (name: string) => {
    const d = draft;
    setDraft(null);
    if (!d || !name) return;
    void (d.kind === "board" ? actions.createBoard(d.folder, name) : actions.createFolder(d.folder, name));
  };

  const commitRename = (name: string) => {
    const r = renaming;
    setRenaming(null);
    if (r && name && name !== nameOf(r.id)) void actions.rename(r.kind, r.id, name);
  };

  const openMenu = (entry: Entry, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ entry, x: e.clientX, y: e.clientY, view: "main" });
  };

  const drag = (entry: Entry) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragged = entry;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", entry.id);
    },
    onDragEnd: () => {
      dragged = null;
      setDropTarget(null);
    },
  });

  const drop = (folder: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!canMove(dragged, folder)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(folder);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const entry = dragged;
      dragged = null;
      setDropTarget(null);
      if (canMove(entry, folder)) void actions.move(entry.kind, entry.id, folder);
    },
  });

  const row = (opts: { entry: Entry; depth: number; icon: ReactNode; label: string; chevron?: boolean; open?: boolean; meta?: ReactNode; dropFolder: string; onClick(): void; title?: string }) => {
    const { entry, depth } = opts;
    if (renaming?.kind === entry.kind && renaming.id === entry.id) {
      return <NameInput key={`${entry.kind}:${entry.id}`} depth={depth} icon={opts.icon} initial={opts.label} onDone={commitRename} />;
    }
    const active = entry.kind === "board" && entry.id === currentId;
    const isMenu = menu?.entry.id === entry.id && menu.entry.kind === entry.kind;
    const classes = ["bp-row", active && "is-active", isMenu && "is-menu", entry.kind === "folder" && dropTarget === entry.id && "is-drop"];
    return (
      <div
        key={`${entry.kind}:${entry.id}`}
        className={classes.filter(Boolean).join(" ")}
        style={{ paddingLeft: indent(depth) }}
        title={opts.title}
        onClick={opts.onClick}
        onDoubleClick={() => setRenaming(entry)}
        onContextMenu={(e) => openMenu(entry, e)}
        {...drag(entry)}
        {...drop(opts.dropFolder)}
      >
        <span className={`bp-chevron${opts.open ? " is-open" : ""}`}>{opts.chevron && ChevronIcon}</span>
        <span className="bp-icon">{opts.icon}</span>
        <span className="bp-name">{opts.label}</span>
        {opts.meta !== undefined && <span className="bp-meta">{opts.meta}</span>}
        <button type="button" className="bp-more" aria-label={`More for ${opts.label}`} onClick={(e) => openMenu(entry, e)}>
          {MoreIcon}
        </button>
      </div>
    );
  };

  const draftRow = (folder: string, depth: number) =>
    draft?.folder === folder && (
      <NameInput key="draft" depth={depth} icon={draft.kind === "board" ? BoardIcon : FolderIcon} initial={draft.initial} onDone={commitDraft} />
    );

  const renderFolder = (node: FolderNode, depth: number): ReactNode[] => [
    draftRow(node.id, depth),
    ...node.folders.flatMap((f) => {
      const open = expanded.has(f.id);
      return [
        row({
          entry: { kind: "folder", id: f.id },
          depth,
          icon: open ? FolderOpenIcon : FolderIcon,
          label: f.name,
          chevron: true,
          open,
          meta: f.count || undefined,
          dropFolder: f.id,
          onClick: () => onExpand(f.id, !open),
        }),
        ...(open ? renderFolder(f, depth + 1) : []),
      ];
    }),
    ...node.boards.map((b) =>
      row({
        entry: { kind: "board", id: b.id },
        depth,
        icon: BoardIcon,
        label: b.name,
        dropFolder: node.id,
        title: `Updated ${new Date(b.updated).toLocaleString()}`,
        onClick: () => actions.open(b.id),
      }),
    ),
  ];

  const needle = filter.trim().toLowerCase();
  const matches = needle ? tree.boards.filter((b) => b.id.toLowerCase().includes(needle)).sort((a, b) => b.updated - a.updated) : [];

  return (
    <div className="bp" ref={panel}>
      <div className="bp-toolbar">
        <label className="bp-search">
          {SearchIcon}
          <input
            value={filter}
            placeholder="Search boards"
            aria-label="Search boards"
            onChange={(e) => onFilter(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") onFilter("");
              if (e.key === "Enter" && matches[0]) actions.open(matches[0].id);
            }}
          />
        </label>
        <button type="button" className="bp-btn" title="New board" aria-label="New board" onClick={() => startCreate("board", "")}>
          {PlusIcon}
        </button>
        <button type="button" className="bp-btn" title="New folder" aria-label="New folder" onClick={() => startCreate("folder", "")}>
          {FolderPlusIcon}
        </button>
      </div>
      <div
        ref={list}
        className={`bp-list${dropTarget === "" ? " is-drop" : ""}`}
        onScroll={(e) => (scroll.current = e.currentTarget.scrollTop)}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropTarget(null)} {...drop("")}>
        {needle ? (
          matches.length ? (
            matches.map((b) =>
              row({
                entry: { kind: "board", id: b.id },
                depth: 0,
                icon: BoardIcon,
                label: nameOf(b.id),
                meta: parentOf(b.id) || undefined,
                dropFolder: parentOf(b.id),
                onClick: () => actions.open(b.id),
              }),
            )
          ) : (
            <p className="bp-empty">No board matches “{filter.trim()}”.</p>
          )
        ) : (
          <>
            {renderFolder(root, 0)}
            {root.count === 0 && !draft && <p className="bp-empty">No boards yet.</p>}
          </>
        )}
      </div>
      {menu && panel.current && (
        <EntryMenu
          menu={menu}
          root={root}
          host={panel.current.closest(".excalidraw") ?? document.body}
          close={() => setMenu(null)}
          onView={(view) => setMenu({ ...menu, view })}
          onCreate={startCreate}
          onRename={setRenaming}
          actions={actions}
        />
      )}
    </div>
  );
}
