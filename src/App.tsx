import { Excalidraw, MainMenu, Sidebar, WelcomeScreen, useHandleLibrary } from "@excalidraw/excalidraw";
import type { LibraryPersistenceAdapter } from "@excalidraw/excalidraw/data/library";
import type { AppState, ExcalidrawImperativeAPI, LibraryItems, UIOptions } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CLIENT_ID, type Kind, type ServerEvent, type Tree, api, boardPath, joinId, nameOf, parentOf } from "./api";
import { type BoardActions, BoardsPanel } from "./BoardsPanel";
import { BoardsIcon } from "./icons";
import { BoardSession, SIDEBAR_PX, type SaveStatus } from "./session";
import { freeName } from "./tree";

const SIDEBAR = "boards";
const NARROW = 900; // below this the sidebar cannot dock, and covers the canvas
// The theme is a prop (so a new board starts in it, with no light flash); toggleTheme
// keeps the menu item, which reports the change through onChange.
const UI_OPTIONS: Partial<UIOptions> = { dockedSidebarBreakpoint: NARROW, canvasActions: { toggleTheme: true } };

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Unsaved",
  saving: "Saving…",
  offline: "Offline, retrying",
  gone: "Board moved or deleted",
  error: "Not saved",
};

// Per-device preferences. Boards themselves never touch browser storage.
const prefs = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // private mode: the preference just does not stick
    }
  },
};

// The shape library is kept on the server too, so it follows you between devices.
// It can be megabytes (icon packs), and every board mounts its own editor, so the
// page loads it once and reuses it. A save always re-reads the server first:
// Excalidraw applies its change on top of that, so additions made elsewhere stay.
let libraryCache: Promise<LibraryItems> | null = null;
const fetchLibrary = () =>
  (libraryCache = api.library().then(
    (r) => r.libraryItems as LibraryItems,
    (err) => {
      libraryCache = null;
      throw err;
    },
  ));
const libraryAdapter: LibraryPersistenceAdapter = {
  load: async ({ source }) => ({ libraryItems: await (source === "save" || !libraryCache ? fetchLibrary() : libraryCache) }),
  save: async ({ libraryItems }) => {
    await api.saveLibrary(libraryItems);
    libraryCache = Promise.resolve(libraryItems);
  },
};

const isNarrow = () => window.innerWidth < NARROW;

const LEAVE_MS = 140; // matches .is-leaving in app.css
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function idFromPath(): string | null {
  const match = location.pathname.match(/^\/b\/(.+)$/);
  if (!match) return null;
  try {
    return match[1].split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}

function ancestors(id: string): string[] {
  const out: string[] = [];
  for (let p = parentOf(id); p; p = parentOf(p)) out.push(p);
  return out;
}

/** Where `current` ends up after `from` moved to `to`, or null if the move does not touch it. */
function afterMove(current: string, kind: Kind, from: string, to: string): string | null {
  if (kind === "board") return current === from ? to : null;
  return current.startsWith(from + "/") ? to + current.slice(from.length) : null;
}

export function App() {
  const [tree, setTree] = useState<Tree | null>(null);
  const [session, setSession] = useState<BoardSession | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [docked, setDocked] = useState(() => prefs.get("boards.docked") !== "false");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(JSON.parse(prefs.get("boards.expanded") ?? "[]")));
  const [filter, setFilter] = useState("");
  const [fatal, setFatal] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const listScroll = useRef(0); // the board list remounts with each board; keep its place
  const sessionRef = useRef<BoardSession | null>(null);
  const excalidrawRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const openSeq = useRef(0);
  const booted = useRef(false);
  const sidebarOpen = useRef(prefs.get("boards.open") !== "false" && !isNarrow());
  const [theme, setTheme] = useState<AppState["theme"]>(
    () => (prefs.get("theme") as AppState["theme"] | null) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );

  useHandleLibrary({ excalidrawAPI: excalidraw, adapter: libraryAdapter });

  const toast = useCallback((message: string) => {
    excalidrawRef.current?.setToast({ message, closable: true, duration: 5000 });
  }, []);

  const refreshTree = useCallback(async () => {
    const next = await api.tree();
    setTree(next);
    return next;
  }, []);

  const expand = useCallback((ids: string[], open = true) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (open) next.add(id);
        else next.delete(id);
      }
      prefs.set("boards.expanded", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const show = useCallback(
    (id: string, how: "push" | "replace" | "none") => {
      setCurrentId(id);
      document.title = `${nameOf(id)} · Excalidraw`;
      if (how === "push") history.pushState(null, "", boardPath(id));
      if (how === "replace") history.replaceState(null, "", boardPath(id));
      expand(ancestors(id));
    },
    [expand],
  );

  const open = useCallback(
    async (id: string, how: "push" | "replace" | "none" = "push") => {
      if (sessionRef.current?.id === id) return;
      const seq = ++openSeq.current;
      // Page turn: the old board slides out while the new one loads, then the new one slides in (app.css).
      const turning = sessionRef.current !== null;
      if (turning) setLeaving(true);
      try {
        await sessionRef.current?.flush();
        const [loaded] = await Promise.all([api.board(id), turning ? sleep(LEAVE_MS) : null]);
        if (seq !== openSeq.current) return; // another board was picked meanwhile
        // The old editor unmounts with the next render; close its session while it can still be read.
        void sessionRef.current?.close();
        const next = new BoardSession(id, loaded, setStatus);
        sessionRef.current = next;
        excalidrawRef.current = null;
        setExcalidraw(null);
        setStatus("saved");
        setSession(next);
        show(id, how);
      } finally {
        if (seq === openSeq.current) setLeaving(false);
      }
    },
    [show],
  );

  /** Open the most recently changed board, or make one if there are none. */
  const openRecent = useCallback(
    async (except?: string) => {
      const t = await refreshTree();
      const recent = t.boards.filter((b) => b.id !== except).sort((a, b) => b.updated - a.updated)[0];
      if (recent) return open(recent.id, "replace");
      const { id } = await api.createBoard("", freeName("Untitled", []));
      await refreshTree();
      return open(id, "replace");
    },
    [open, refreshTree],
  );

  const followMove = useCallback(
    (kind: Kind, from: string, to: string) => {
      if (kind === "folder") {
        setExpanded((prev) => new Set([...prev].map((e) => (e === from ? to : afterMove(e, kind, from, to) ?? e))));
      }
      const s = sessionRef.current;
      const moved = s && afterMove(s.id, kind, from, to);
      if (s && moved) {
        s.rename(moved);
        show(moved, "replace");
      }
    },
    [show],
  );

  // First load: the board in the URL, else the most recent one.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      const t = await refreshTree();
      const wanted = idFromPath();
      if (wanted && t.boards.some((b) => b.id === wanted)) await open(wanted, "replace");
      else await openRecent();
    })().catch((err) => setFatal(err instanceof Error ? err.message : String(err)));
  }, [refreshTree, open, openRecent]);

  useEffect(() => {
    const onPop = () => {
      const id = idFromPath();
      if (id) open(id, "none").catch((err) => toast(err.message));
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, [open, toast]);

  // Live updates from the server: agents drawing, other tabs, moves and deletes.
  useEffect(() => {
    const events = new EventSource("/api/events");
    let connected = false;
    events.onopen = () => {
      if (connected) {
        // Reconnected: events may have been missed, so catch up.
        refreshTree().catch(() => {});
        sessionRef.current?.remoteChanged("");
      }
      connected = true;
    };
    events.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as ServerEvent;
      const s = sessionRef.current;
      if (e.type === "tree") refreshTree().catch(() => {});
      else if (e.type === "board" && s && e.id === s.id && e.by !== CLIENT_ID) s.remoteChanged(e.etag, e.focus);
      else if (e.type === "moved") followMove(e.kind, e.from, e.to);
      else if (e.type === "deleted" && s && (e.kind === "board" ? s.id === e.id : s.id.startsWith(e.id + "/"))) {
        toast(`“${nameOf(s.id)}” was moved to the trash`);
        openRecent(s.id).catch((err) => toast(err.message));
      }
    };
    return () => events.close();
  }, [refreshTree, followMove, openRecent, toast]);

  // Do not lose the last edit: save when the tab is hidden, warn when closing with unsaved work.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && void sessionRef.current?.flush();
    const onUnload = (e: BeforeUnloadEvent) => {
      if (sessionRef.current?.hasPendingChanges()) e.preventDefault();
    };
    document.addEventListener("visibilitychange", onHide);
    addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      removeEventListener("beforeunload", onUnload);
    };
  }, []);

  const actions = useMemo<BoardActions>(() => {
    const guard =
      <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
      async (...args: A) => {
        try {
          await fn(...args);
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err));
        }
      };
    const moveEntry = async (kind: Kind, from: string, to: string) => {
      if (from === to) return;
      const s = sessionRef.current;
      if (s && afterMove(s.id, kind, from, to)) await s.flush();
      await api.move(kind, from, to);
      followMove(kind, from, to);
      expand(ancestors(to));
      await refreshTree();
    };
    return {
      open: (id) => {
        if (isNarrow()) excalidrawRef.current?.toggleSidebar({ name: SIDEBAR, force: false });
        void guard(open)(id);
      },
      createBoard: guard(async (folder, name) => {
        const { id } = await api.createBoard(folder, name);
        await refreshTree();
        await open(id);
      }),
      createFolder: guard(async (folder, name) => {
        const { id } = await api.createFolder(folder, name);
        expand([...ancestors(id), id]);
        await refreshTree();
      }),
      rename: guard((kind, id, name) => moveEntry(kind, id, joinId(parentOf(id), name))),
      move: guard((kind, id, folder) => moveEntry(kind, id, joinId(folder, nameOf(id)))),
      remove: guard(async (kind, id) => {
        const what = kind === "board" ? `the board “${nameOf(id)}”` : `the folder “${nameOf(id)}” and everything in it`;
        if (window.confirm(`Move ${what} to the trash?`)) await api.remove(kind, id);
      }),
    };
  }, [open, refreshTree, expand, followMove, toast]);

  if (!session || !tree) return <div className="boot">{fatal ? `Could not load boards: ${fatal}` : "Loading…"}</div>;

  const name = nameOf(currentId ?? session.id);
  return (
    <div className={leaving ? "app is-leaving" : "app"} data-theme={theme}>
      <Excalidraw
        key={session.key}
        initialData={session.initialData(
          { openSidebar: sidebarOpen.current ? { name: SIDEBAR } : null },
          sidebarOpen.current && docked && !isNarrow() ? SIDEBAR_PX : 0,
        )}
        excalidrawAPI={(x) => {
          session.attach(x);
          excalidrawRef.current = x;
          setExcalidraw(x);
        }}
        onChange={(_elements, appState) => {
          session.changed();
          if (appState.theme !== theme) {
            setTheme(appState.theme);
            prefs.set("theme", appState.theme);
            document.documentElement.dataset.theme = appState.theme;
          }
        }}
        name={name}
        theme={theme}
        UIOptions={UI_OPTIONS}
        renderTopRightUI={(isMobile) => (
          <div className="top-right">
            <div className={`save-badge is-${status}`} title={`${currentId ?? session.id}: ${session.error || STATUS_TEXT[status]}`} role="status">
              {!isMobile && <span className="board-name">{name}</span>}
              <span className="dot" />
              {!isMobile && <span>{status === "error" && session.error ? `Not saved: ${session.error}` : STATUS_TEXT[status]}</span>}
            </div>
            <Sidebar.Trigger name={SIDEBAR} icon={BoardsIcon} title="Boards">
              {!isMobile && "Boards"}
            </Sidebar.Trigger>
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.Item icon={BoardsIcon} onSelect={() => excalidrawRef.current?.toggleSidebar({ name: SIDEBAR })}>
            Boards
          </MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Hints.MenuHint />
          <WelcomeScreen.Hints.ToolbarHint />
          <WelcomeScreen.Hints.HelpHint />
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Logo />
            <WelcomeScreen.Center.Heading>“{name}” is empty. Draw something, or ask your agent to.</WelcomeScreen.Center.Heading>
          </WelcomeScreen.Center>
        </WelcomeScreen>
        <Sidebar
          name={SIDEBAR}
          docked={docked}
          onDock={(value) => {
            setDocked(value);
            prefs.set("boards.docked", String(value));
          }}
          onStateChange={(state) => {
            sidebarOpen.current = state?.name === SIDEBAR;
            if (!isNarrow()) prefs.set("boards.open", String(sidebarOpen.current));
          }}
        >
          <Sidebar.Header>
            <div className="bp-title">Boards</div>
          </Sidebar.Header>
          <BoardsPanel
            tree={tree}
            currentId={currentId}
            expanded={expanded}
            onExpand={(id, isOpen) => expand([id], isOpen)}
            filter={filter}
            scroll={listScroll}
            onFilter={setFilter}
            actions={actions}
          />
        </Sidebar>
      </Excalidraw>
    </div>
  );
}
