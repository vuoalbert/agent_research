"use client";

import { ArrowLeft, FileText, Folder, FolderOpen } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import { Markdown } from "@/components/ai/markdown";
import { NO_SCROLLBAR } from "@/components/ai/tokens";
import { Button } from "@/components/ui/button";
import { hostOf } from "@/components/knowledge-base";
import { useAgentStore } from "@/lib/agent-store";
import { cn } from "@/lib/utils";
import {
  linkifyWikilinks,
  markContradictions,
  MISSING_HREF,
  pathFromHref,
  type VaultNoteView,
  type VaultTree,
  type VaultTreeFolder,
  type VaultTreeNode,
} from "@/lib/vault-browse";

/**
 * The References panel: the research vault (`Research/`, `Sources/`,
 * `Claims/` and any folder the user made) as an Obsidian-style file tree.
 * A note opens in the panel — its type, date and original page above it, its
 * Markdown below, `[[links]]` that open the note they name — with a back
 * button that walks the notes opened so far, then returns to the tree.
 *
 * Like the Knowledge base, the heading stays put and only the area below it
 * scrolls (scrollbar hidden, shadcn's `scroll-fade-y` mask at the edges).
 * The tree is fetched when the panel opens and again when a chat turn finishes (a turn may have
 * written notes); nothing polls.
 */

export const TREE_ENDPOINT = "/api/vault/tree";
export const NOTE_ENDPOINT = "/api/vault/note";

/* the Button primitive's box, reset to an Obsidian-like tree row */
const ROW =
  "h-[30px] w-full min-w-0 justify-start gap-1.5 rounded-md border-0 px-0 pr-1.5 text-left font-normal hover:bg-[#F9F9F9] focus-visible:bg-[#F9F9F9] focus-visible:ring-0 active:not-aria-[haspopup]:translate-y-0 motion-reduce:transition-none";
const INDENT = 14;
const rowPadding = (depth: number) => ({ paddingLeft: 6 + depth * INDENT });

type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "missing" } | { status: "error" };

/* ── Tree ──────────────────────────────────────────────────────────────────── */

function TreeNodes({
  nodes,
  depth,
  collapsed,
  onToggle,
  onOpen,
}: {
  nodes: VaultTreeNode[];
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <ul role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Vault" : undefined} className="flex flex-col">
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <FolderNode
            key={`d:${node.path}`}
            folder={node}
            depth={depth}
            collapsed={collapsed}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ) : (
          <li key={`n:${node.path}`} role="none">
            <Button
              variant="nav"
              role="treeitem"
              data-ref-note={node.path}
              title={node.title}
              onClick={() => onOpen(node.path)}
              className={ROW}
              style={rowPadding(depth)}
            >
              <FileText aria-hidden size={16} className="shrink-0 text-plane-faint" />
              <span className="min-w-0 truncate text-[13px] leading-5 text-plane-ink-2">{node.title}</span>
            </Button>
          </li>
        ),
      )}
    </ul>
  );
}

function FolderNode({
  folder,
  depth,
  collapsed,
  onToggle,
  onOpen,
}: {
  folder: VaultTreeFolder;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const open = !collapsed.has(folder.path);
  const Icon = open ? FolderOpen : Folder;
  return (
    <li role="none">
      <Button
        variant="nav"
        role="treeitem"
        aria-expanded={open}
        data-ref-folder={folder.path}
        title={folder.name}
        onClick={() => onToggle(folder.path)}
        className={ROW}
        style={rowPadding(depth)}
      >
        <Icon aria-hidden size={16} className="shrink-0 text-plane-faint" />
        <span className="min-w-0 truncate text-[13px] leading-5 font-medium text-plane-ink">{folder.name}</span>
      </Button>
      {open && folder.children.length > 0 && (
        <div className="relative">
          {/* the indent guide, under the folder's icon */}
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-plane-border"
            style={{ left: 6 + depth * INDENT + 7.5 }}
          />
          <TreeNodes
            nodes={folder.children}
            depth={depth + 1}
            collapsed={collapsed}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        </div>
      )}
    </li>
  );
}

/* ── Note ──────────────────────────────────────────────────────────────────── */

/** a body's leading `# Heading` as the note's display title, and the body without it */
export function splitTitle(note: VaultNoteView): { title: string; body: string } {
  const match = /^# +(.+?)\s*(?:\n|$)/.exec(note.body);
  if (!match) return { title: note.title, body: note.body };
  return { title: match[1].replace(/\s+#+$/, "").trim() || note.title, body: note.body.slice(match[0].length).trim() };
}

function NoteMeta({ note }: { note: VaultNoteView }) {
  const { type, updated, url } = note.frontmatter;
  const date = updated || note.frontmatter.date;
  const link = url && /^https?:\/\//i.test(url) ? url : undefined;
  const parts = [type && <span key="type" className="capitalize">{type}</span>, date && <span key="date">{date}</span>];
  if (link) {
    parts.push(
      <Link
        key="url"
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        prefetch={false}
        title={link}
        data-ref="source-link"
        className="min-w-0 truncate underline decoration-[#C4C6C8] underline-offset-2 hover:text-plane-ink hover:decoration-plane-ink"
      >
        {hostOf(link)}
      </Link>,
    );
  }
  const shown = parts.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <p data-ref="meta" className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-plane-faint">
      {shown.map((part, i) => (
        <span key={i} className={cn("contents", i > 0 && "before:content-['·']")}>
          {part}
        </span>
      ))}
    </p>
  );
}

function NoteBody({
  note,
  titles,
  onOpen,
}: {
  note: VaultNoteView;
  titles: Record<string, string>;
  onOpen: (path: string) => void;
}) {
  const { title, body } = splitTitle(note);
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (href === MISSING_HREF) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = pathFromHref(href);
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    onOpen(target);
  };
  return (
    <article data-ref="note" data-ref-path={note.path} className="flex flex-col gap-1 pb-2">
      <h3 className="text-[15px] leading-[22px] font-semibold text-plane-ink [overflow-wrap:anywhere]">{title}</h3>
      <NoteMeta note={note} />
      {body && (
        <div onClickCapture={onClickCapture}>
          <Markdown
            className={cn(
              "mt-1 px-0 py-0 text-[14px] leading-[22px]",
              "[&_h1]:mt-4 [&_h1]:mb-1 [&_h1]:text-[15px] [&_h1]:leading-[22px]",
              "[&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:text-[14px] [&_h2]:leading-[22px]",
              "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[14px] [&_h3]:leading-[22px]",
              "[&_p]:my-2 [&_ol]:my-2 [&_ol]:pl-5 [&_ul]:my-2 [&_ul]:pl-5 [&_blockquote]:pl-3",
              // an entry that contradicts the claim: the app's solid conflict red
              "[&_ins]:text-[#DC2626] [&_ins]:no-underline [&_ins_a]:text-[#DC2626] [&_ins_a]:decoration-[#DC2626]/40 [&_ins_a:hover]:decoration-[#DC2626] [&_li:has(>ins)]:marker:text-[#DC2626]",
              // a [[link]] to a note the vault does not have: muted, inert
              "[&_a[href='#vault-missing']]:pointer-events-none [&_a[href='#vault-missing']]:cursor-default [&_a[href='#vault-missing']]:text-plane-faint [&_a[href='#vault-missing']]:no-underline",
            )}
          >
            {linkifyWikilinks(markContradictions(body), titles)}
          </Markdown>
        </div>
      )}
    </article>
  );
}

/* ── Panel ─────────────────────────────────────────────────────────────────── */

export function References({ titleId, open = true }: { titleId: string; open?: boolean }) {
  const [tree, setTree] = useState<Load<VaultTree>>({ status: "loading" });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  /** the notes opened from the tree, oldest first; empty shows the tree */
  const [history, setHistory] = useState<string[]>([]);
  const [note, setNote] = useState<Load<VaultNoteView>>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const current = history.at(-1);

  const treeRequest = useRef(0);
  const loadTree = useCallback(async () => {
    const id = ++treeRequest.current;
    try {
      const response = await fetch(TREE_ENDPOINT, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as VaultTree;
      if (id === treeRequest.current) setTree({ status: "ready", data });
    } catch {
      if (id === treeRequest.current) setTree((prev) => (prev.status === "ready" ? prev : { status: "error" }));
    }
  }, []);

  /* fetched each time the panel opens */
  useEffect(() => {
    if (open) void loadTree();
  }, [open, loadTree]);

  /* …and when a chat turn finishes, which may have written notes */
  const { streaming } = useAgentStore();
  const busy = streaming.length > 0;
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      void loadTree();
      setReload((n) => n + 1);
    }
    wasBusy.current = busy;
  }, [busy, loadTree]);

  useEffect(() => {
    if (!current) return;
    let live = true;
    setNote((prev) => (prev.status === "ready" && prev.data.path === current ? prev : { status: "loading" }));
    fetch(`${NOTE_ENDPOINT}?path=${encodeURIComponent(current)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 404) return setNote({ status: "missing" });
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as VaultNoteView;
        if (live) setNote({ status: "ready", data });
      })
      .catch(() => live && setNote({ status: "error" }));
    return () => {
      live = false;
    };
  }, [current, reload]);

  const openNote = useCallback(
    (path: string) => setHistory((stack) => (stack.at(-1) === path ? stack : [...stack, path])),
    [],
  );
  const openFromTree = useCallback((path: string) => setHistory([path]), []);
  const back = () => setHistory((stack) => stack.slice(0, -1));
  const toggle = useCallback(
    (path: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    [],
  );

  const titles = tree.status === "ready" ? tree.data.titles : {};
  const empty = tree.status === "ready" && tree.data.count === 0;

  return (
    <div data-ref="root" className="flex h-full min-h-0 flex-col">
      <div data-ref="header" className="flex h-5 shrink-0 items-center gap-1.5">
        {current && (
          <Button
            variant="nav"
            size="icon-xs"
            aria-label={history.length > 1 ? "Back to the previous note" : "Back to all references"}
            title="Back"
            data-ref="back"
            onClick={back}
            className="-my-0.5 -ml-1 rounded-md border-0 text-plane-muted hover:bg-[#F9F9F9] hover:text-plane-ink focus-visible:bg-[#F9F9F9] focus-visible:ring-0 active:not-aria-[haspopup]:translate-y-0 motion-reduce:transition-none"
          >
            <ArrowLeft aria-hidden size={16} className="size-4" />
          </Button>
        )}
        <h2 id={titleId} className="text-[13px] leading-5 font-semibold text-plane-ink">
          References
        </h2>
      </div>

      {current ? (
        <div
          key={current}
          data-ref="note-scroll"
          className={cn("scroll-fade-y scroll-fade-7 -mx-4 mt-2 min-h-0 flex-1 overflow-y-auto px-4", NO_SCROLLBAR)}
        >
          {note.status === "ready" ? (
            <NoteBody note={note.data} titles={titles} onOpen={openNote} />
          ) : note.status === "missing" || note.status === "error" ? (
            <p data-ref="note-missing" className="mt-4 text-[13px] leading-5 text-plane-muted">
              {note.status === "missing" ? "This note is no longer in the vault." : "Couldn't open this note."}
            </p>
          ) : null}
        </div>
      ) : null}

      {empty || tree.status === "error" ? (
        <div data-ref="empty" className={cn("mt-6 flex flex-col items-center gap-2 text-center", current && "hidden")}>
          <Folder aria-hidden size={18} className="text-plane-faint" />
          <p className="text-[13px] leading-5 text-plane-muted">
            {tree.status === "error" ? "Couldn't read the vault" : "Research notes will appear here"}
          </p>
        </div>
      ) : tree.status === "ready" ? (
        /* kept mounted under an open note, so back returns to the same scroll and folds */
        <div
          data-ref="scroll"
          className={cn(
            "scroll-fade-y scroll-fade-7 -mx-4 mt-2 min-h-0 flex-1 overflow-y-auto px-3",
            NO_SCROLLBAR,
            current && "hidden",
          )}
        >
          <TreeNodes nodes={tree.data.children} depth={0} collapsed={collapsed} onToggle={toggle} onOpen={openFromTree} />
        </div>
      ) : null}
    </div>
  );
}
