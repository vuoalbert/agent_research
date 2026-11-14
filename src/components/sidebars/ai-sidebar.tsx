"use client";

import {
  Archive,
  Boxes,
  Briefcase,
  Check,
  Clipboard,
  Clock,
  Ellipsis,
  Folder,
  ListTodo,
  Mail,
  MailOpen,
  Pencil,
  Pin,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentStore, type Chat } from "@/lib/agent-store";
import { cn } from "@/lib/utils";

/**
 * AiSidebar — the body of the sidebar card on the `ai` app.
 *
 * It is adapted from an Agent nav panel, re-cut to this app's
 * measured chrome: the 250px card, the 32px row pitch, 13px Inter, the
 * `--plane-*` ink, and shadcn Buttons for every control. Structure, glyphs and
 * copy are the reference's; not one number is.
 *
 * ## What sits above this component
 *
 * `sidebar.tsx` draws the card, the app-name header and the outlined "New"
 * button at the measured y 97..129 — on every rail app, as card chrome. **That
 * button is this column's "New" row.** Drawing a second one here would put two
 * "New"s in the card, so instead this component adopts the existing one: on
 * mount it binds a click listener to `[data-sidebar-new]` and unbinds on
 * unmount, which is the only way a client child can add behaviour to a control
 * its server-rendered parent owns. `sidebar.tsx`'s whole diff for this app is
 * that attribute plus the switch that mounts this file.
 *
 * ## Rhythm below it (page y)
 *
 *   128.98       "New" button bottom — the New row
 *   143.83       Projects · Artifacts · Scheduled · Customize, h 32, pitch 32
 *   283.83       "PROJECTS" heading, h 24 — 11px caps, 0.07em, --plane-faint
 *   307.83       How Agent Research works
 *   383.83       "CHATS AND TASKS" heading
 *   407.83..843  chat rows — the only part of the column that can grow, so the
 *                only part that scrolls; it ends exactly on the divider, so
 *                the divider and trial pill keep their measured offsets.
 *
 * Verified in the browser at 1440x900: every row is x 73..298, h 32, on a 32px
 * pitch, and the list's bottom is 843 — the divider's measured y.
 *
 * Glyphs are 16px lucide at `--plane-faint`, the way the reference washes them
 * out — labels carry the ink, icons only mark the row. Chat rows swap the
 * glyph for a 6px hollow bullet centred in the same 16px slot, so every label
 * in the column starts on the measured x=104.
 */

/** rows share the 32px / 13px box the Home nav rows use — sidebar.tsx's `rowBase` */
const ROW = "flex h-[32px] w-full items-center justify-start gap-0 rounded-[6px] border-0 pr-[8px] pl-[8px] text-[13.15px] transition-none";

/** every glyph in this column sits in the same 16px slot, washed out */
const GLYPH = { width: 16, height: 16, strokeWidth: 1.75 } as const;

/**
 * The four rows under "New". All inert: this clone reproduces the column, and
 * the reference's own `Artifacts` / `Scheduled` / `Customize` are shape too.
 */
const TOOLS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "projects", label: "Projects", icon: Folder },
  { id: "artifacts", label: "Artifacts", icon: Boxes },
  { id: "scheduled", label: "Scheduled", icon: Clock },
  { id: "customize", label: "Customize", icon: Briefcase },
];

/** The two real project destinations already shown in this sidebar. */
const PROJECTS = ["How Agent Research works"] as const;

const MENU =
  "w-auto min-w-[210px] rounded-[10px] border border-plane-border bg-white p-1 text-[13px] shadow-[0_1px_2px_rgba(15,15,16,0.04),0_12px_32px_rgba(15,15,16,0.10)] ring-0";
const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-[7px] px-2 py-[7px] text-[13px] leading-none text-plane-ink-2 outline-none data-highlighted:bg-plane-page data-highlighted:text-plane-ink";
const SUB_TRIGGER = `${MENU_ITEM} data-popup-open:bg-plane-page data-popup-open:text-plane-ink data-open:bg-plane-page data-open:text-plane-ink`;

/** --------------------------------------------------------------- pieces */

/** A heading over a group, with its trailing glyph button. Both are inert. */
function GroupHeader({
  label,
  icon: Icon,
  action,
}: {
  label: string;
  icon: LucideIcon;
  action: string;
}) {
  return (
    <div
      data-agent-group={label}
      className="flex h-[24px] w-full items-center pr-[4px] pl-[8px]"
    >
      <span className="truncate text-[11px] font-medium tracking-[0.07em] text-plane-faint uppercase">
        {label}
      </span>
      <Button
        variant="ghost"
        aria-label={action}
        className="ml-auto size-[20px] shrink-0 rounded-[4px] border-0 p-0 text-plane-faint"
      >
        <Icon aria-hidden width={13} height={13} strokeWidth={2} className="size-[13px]" />
      </Button>
    </div>
  );
}

/** A sidebar row: tool rows stay inert; real project rows can filter chats. */
function ToolRow({
  id,
  label,
  icon: Icon,
  active = false,
  onClick,
}: {
  id: string;
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      variant={active ? "nav-active" : "nav"}
      data-agent-nav={id}
      aria-pressed={onClick ? active : undefined}
      onClick={onClick}
      className={ROW}
    >
      <Icon aria-hidden {...GLYPH} className="shrink-0 text-plane-faint" />
      <span className="ml-[6px] truncate">{label}</span>
    </Button>
  );
}

/** 6px of ring, no fill — centred in the 16px slot the glyph rows use. */
function ChatBullet() {
  return (
    <span aria-hidden className="flex w-[16px] shrink-0 justify-center">
      <span className="size-[6px] rounded-full ring-1 ring-plane-faint" />
    </span>
  );
}

function ChatSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-agent-chat-group={label}>
      <div className="flex h-[24px] items-center px-[8px] text-[11px] font-medium tracking-[0.07em] text-plane-faint uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function ChatRow({
  chat,
  active,
  renaming,
  onOpen,
  onRename,
  onStartRename,
  onQuickTask,
  onCopySessionId,
  onTogglePin,
  onToggleUnread,
  onSetProject,
  groups,
  onSetGroup,
  onCreateGroup,
  onArchive,
  onDelete,
  onDoneRenaming,
}: {
  chat: Chat;
  active: boolean;
  renaming: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onStartRename: () => void;
  onQuickTask: () => void;
  onCopySessionId: () => void;
  onTogglePin: () => void;
  onToggleUnread: () => void;
  onSetProject: (project: string | null) => void;
  groups: readonly string[];
  onSetGroup: (group: string | null) => void;
  onCreateGroup: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onDoneRenaming: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const handleMenuKeyDown = (event: ReactKeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (!/^[purad]$/.test(key) || event.defaultPrevented || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    const target = event.target as HTMLElement | null;
    const item = target?.closest<HTMLElement>('[role="menuitem"]');
    // Keep letters available to Base UI's submenu/typeahead behavior. Only a
    // focused leaf in this menu owns the five advertised shortcuts.
    if (
      !item ||
      item.matches('[data-slot="dropdown-menu-sub-trigger"]') ||
      item.closest('[data-slot="dropdown-menu-sub-content"]')
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setMenuOpen(false);
    if (key === "p") onTogglePin();
    if (key === "u") onToggleUnread();
    if (key === "r") onStartRename();
    if (key === "a") onArchive();
    if (key === "d") onDelete();
  };

  if (renaming) {
    return (
      <div className={cn(ROW, "text-plane-ink-2")}>
        <ChatBullet />
        <Input
          autoFocus
          defaultValue={chat.title}
          aria-label={`Rename ${chat.title}`}
          data-agent-chat-rename={chat.id}
          // Enter commits, blur commits, Escape abandons — the one way out of a
          // field that is a mistake is the one that throws the typing away.
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onRename(event.currentTarget.value);
              onDoneRenaming();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onDoneRenaming();
            }
          }}
          onBlur={(event) => {
            onRename(event.target.value);
            onDoneRenaming();
          }}
          className="ml-[6px] h-[20px] min-w-0 flex-1 rounded-[3px] border-plane-border-strong bg-transparent px-[3px] py-0 text-[13.15px] md:text-[13.15px]"
        />
      </div>
    );
  }

  return (
    <div
      className="group/chat relative overflow-hidden"
      // right-click is the reference's way into this menu; the ⋯ is the other
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <Button
        variant={active ? "nav-active" : "nav"}
        data-agent-chat={chat.id}
        aria-current={active ? "page" : undefined}
        data-unread={chat.unread ? "true" : undefined}
        data-pinned={chat.pinned ? "true" : undefined}
        onClick={onOpen}
        // room on the right for the ⋯, so a long title never runs under it
        className={cn(ROW, "pr-[48px]", chat.unread && "font-medium")}
      >
        <ChatBullet />
        <span className="ml-[6px] truncate">{chat.title}</span>
      </Button>
      {chat.pinned ? (
        <Pin
          aria-label="Pinned"
          className="pointer-events-none absolute top-[9px] right-[28px] size-[13px] text-plane-faint"
          strokeWidth={1.8}
        />
      ) : null}

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              aria-label={`Actions for ${chat.title}`}
              data-agent-chat-menu={chat.id}
              className={cn(
                "absolute top-[4px] right-[4px] size-[24px] rounded-[4px] border-0 p-0 text-plane-faint opacity-0",
                "group-hover/chat:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100",
              )}
            />
          }
        >
          <Ellipsis aria-hidden width={14} height={14} strokeWidth={2} className="size-[14px]" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU} onKeyDown={handleMenuKeyDown}>
          <DropdownMenuItem className={MENU_ITEM} onClick={onQuickTask}>
            <ListTodo aria-hidden className="size-[15px] text-plane-faint" />
            <span className="min-w-0 flex-1 truncate">Open as quick task</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator className="-mx-0.5 my-1 bg-plane-border" />
          <DropdownMenuItem className={MENU_ITEM} onClick={onCopySessionId}>
            <Clipboard aria-hidden className="size-[15px] text-plane-faint" />
            <span className="min-w-0 flex-1 truncate">Copy session ID</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator className="-mx-0.5 my-1 bg-plane-border" />
          <DropdownMenuItem className={MENU_ITEM} aria-keyshortcuts="P" onClick={onTogglePin}>
            <Pin aria-hidden className="size-[15px] text-plane-faint" />
            <span className="min-w-0 flex-1 truncate">{chat.pinned ? "Unpin" : "Pin"}</span>
            <DropdownMenuShortcut aria-hidden className="text-[11px] text-plane-faint">P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM} aria-keyshortcuts="U" onClick={onToggleUnread}>
            {chat.unread ? (
              <MailOpen aria-hidden className="size-[15px] text-plane-faint" />
            ) : (
              <Mail aria-hidden className="size-[15px] text-plane-faint" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {chat.unread ? "Mark as read" : "Mark as unread"}
            </span>
            <DropdownMenuShortcut aria-hidden className="text-[11px] text-plane-faint">U</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM} aria-keyshortcuts="R" onClick={onStartRename}>
            <Pencil aria-hidden className="size-[15px] text-plane-faint" />
            <span className="min-w-0 flex-1 truncate">Rename</span>
            <DropdownMenuShortcut aria-hidden className="text-[11px] text-plane-faint">R</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger openOnHover className={SUB_TRIGGER}>
              <Folder aria-hidden className="size-[15px] text-plane-faint" />
              <span className="min-w-0 flex-1 truncate">Add to project</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={cn(MENU, "min-w-[176px]")} sideOffset={6}>
              <DropdownMenuItem className={MENU_ITEM} onClick={() => onSetProject(null)}>
                <span className="min-w-0 flex-1 truncate">None</span>
                <Check
                  aria-hidden
                  className={cn("ml-auto size-[14px]", chat.project ? "invisible" : "")}
                />
              </DropdownMenuItem>
              {PROJECTS.map((project) => (
                <DropdownMenuItem
                  key={project}
                  className={MENU_ITEM}
                  data-project-selected={chat.project === project ? "true" : undefined}
                  onClick={() => onSetProject(project)}
                >
                  <span className="min-w-0 flex-1 truncate">{project}</span>
                  <Check
                    aria-hidden
                    className={cn("ml-auto size-[14px]", chat.project === project ? "" : "invisible")}
                  />
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger openOnHover className={SUB_TRIGGER}>
              <Folder aria-hidden className="size-[15px] text-plane-faint" />
              <span className="min-w-0 flex-1 truncate">Move to group</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={cn(MENU, "min-w-[150px]")} sideOffset={6}>
              <DropdownMenuItem className={MENU_ITEM} onClick={() => onSetGroup(null)}>
                <span className="min-w-0 flex-1 truncate">None</span>
                <Check
                  aria-hidden="true"
                  className={cn("ml-auto size-[14px]", chat.group ? "invisible" : "")}
                />
              </DropdownMenuItem>
              {groups.length === 0 ? (
                <DropdownMenuItem disabled className={MENU_ITEM} data-agent-group-empty>
                  No groups yet
                </DropdownMenuItem>
              ) : (
                groups.map((group) => (
                  <DropdownMenuItem
                    key={group}
                    className={MENU_ITEM}
                    data-group-selected={chat.group === group ? "true" : undefined}
                    onClick={() => onSetGroup(group)}
                  >
                    <span className="min-w-0 flex-1 truncate">{group}</span>
                    <Check
                      aria-hidden
                      className={cn("ml-auto size-[14px]", chat.group === group ? "" : "invisible")}
                    />
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator className="-mx-0.5 my-1 bg-plane-border" />
              <DropdownMenuItem className={MENU_ITEM} onClick={onCreateGroup}>
                <Plus aria-hidden className="size-[15px] text-plane-faint" />
                Create group…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator className="-mx-0.5 my-1 bg-plane-border" />
          <DropdownMenuItem className={MENU_ITEM} aria-keyshortcuts="A" onClick={onArchive}>
            <Archive aria-hidden className="size-[15px] text-plane-faint" />
            <span className="min-w-0 flex-1 truncate">Archive</span>
            <DropdownMenuShortcut aria-hidden className="text-[11px] text-plane-faint">A</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            className={cn(MENU_ITEM, "text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive")}
            aria-keyshortcuts="D"
            onClick={onDelete}
          >
            <Trash2 aria-hidden className="size-[15px]" />
            <span className="min-w-0 flex-1 truncate">Delete</span>
            <DropdownMenuShortcut aria-hidden className="text-[11px] text-destructive">D</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function QuickTaskPanel({
  chat,
  preview,
  open,
  onClose,
  onOpenChat,
}: {
  chat: Chat;
  preview?: string;
  open: boolean;
  onClose: () => void;
  onOpenChat: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent>
        <div className="flex items-start justify-between gap-3">
          <div>
            <DialogTitle>Quick task</DialogTitle>
            <DialogDescription className="mt-1">{chat.title}</DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close Quick task"
            onClick={onClose}
            className="text-plane-faint"
          >
            <X aria-hidden />
          </Button>
        </div>
        {preview ? (
          <p className="rounded-[8px] bg-plane-page px-3 py-2 text-[13px] leading-5 text-plane-ink-2">
            {preview}
          </p>
        ) : null}
        <Button onClick={onOpenChat} className="self-end">
          Open conversation
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function CreateGroupDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();

  useEffect(() => {
    if (!open) setName("");
  }, [open]);

  const create = () => {
    if (!trimmed) return;
    onCreate(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div>
          <DialogTitle>Create group</DialogTitle>
          <DialogDescription className="mt-1">
            Give related chats a shared place in the sidebar.
          </DialogDescription>
        </div>
        <Input
          autoFocus
          aria-label="Group name"
          placeholder="Group name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              create();
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!trimmed}>
            Create group
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** ---------------------------------------------------------------- region */

export function AiSidebar() {
  const {
    chats,
    messages,
    groups,
    activeChatId,
    newChat,
    openChat,
    renameChat,
    toggleChatPinned,
    toggleChatUnread,
    setChatProject,
    setChatGroup,
    createChatGroup,
    archiveChat,
    unarchiveChat,
    deleteChat,
    seedIfEmpty,
  } = useAgentStore();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [quickTaskChatId, setQuickTaskChatId] = useState<string | null>(null);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [groupChatId, setGroupChatId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  useEffect(() => {
    seedIfEmpty();
  }, [seedIfEmpty]);

  // `newChat` is stable, but read it through a ref so the listener below binds
  // once per mount rather than re-binding on every store update.
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;

  /**
   * Adopt the card's existing "New" button as this column's New row. It is
   * rendered by `sidebar.tsx`, which is a server component and so cannot carry
   * an `onClick`; binding it here keeps that file's diff to one attribute and
   * keeps the button single — see the header comment.
   */
  useEffect(() => {
    const button = document.querySelector<HTMLElement>("[data-sidebar-new]");
    if (!button) return;
    const onClick = () => newChatRef.current();
    button.addEventListener("click", onClick);
    return () => button.removeEventListener("click", onClick);
  }, []);

  const visibleChats = [...chats]
    .filter((chat) => !chat.archived)
    .sort((left, right) => Number(right.pinned === true) - Number(left.pinned === true));
  const filteredChats = projectFilter
    ? visibleChats.filter((chat) => chat.project === projectFilter)
    : visibleChats;
  const groupedChats = groups.map((group) => ({
    group,
    chats: filteredChats.filter((chat) => chat.group === group),
  }));
  const ungroupedChats = filteredChats.filter((chat) => !chat.group || !groups.includes(chat.group));
  const archivedChats = chats.filter((chat) => chat.archived);
  const quickTaskChat = quickTaskChatId
    ? chats.find((chat) => chat.id === quickTaskChatId)
    : undefined;

  const copySessionId = (id: string) => {
    void (async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(id);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = id;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
        }
        setCopiedId(id);
        window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1600);
      } catch {
        // Clipboard permissions are optional; the menu remains usable.
      }
    })();
  };

  const handleDelete = (id: string) => {
    if (quickTaskChatId === id) setQuickTaskChatId(null);
    deleteChat(id);
  };

  const createGroup = (name: string) => {
    createChatGroup(name, groupChatId ?? undefined);
    setGroupChatId(null);
  };

  const renderChat = (chat: Chat) => (
    <ChatRow
      key={chat.id}
      chat={chat}
      active={chat.id === activeChatId}
      renaming={chat.id === renamingId}
      onOpen={() => openChat(chat.id)}
      onRename={(title) => renameChat(chat.id, title)}
      onStartRename={() => setRenamingId(chat.id)}
      onQuickTask={() => setQuickTaskChatId(chat.id)}
      onCopySessionId={() => copySessionId(chat.id)}
      onTogglePin={() => toggleChatPinned(chat.id)}
      onToggleUnread={() => toggleChatUnread(chat.id)}
      onSetProject={(project) => setChatProject(chat.id, project)}
      groups={groups}
      onSetGroup={(group) => setChatGroup(chat.id, group)}
      onCreateGroup={() => {
        setGroupChatId(chat.id);
        setCreateGroupOpen(true);
      }}
      onArchive={() => archiveChat(chat.id)}
      onDoneRenaming={() => setRenamingId(null)}
      onDelete={() => handleDelete(chat.id)}
    />
  );

  return (
    <div data-agent-sidebar className="flex min-h-0 flex-1 flex-col">
      <nav className="mt-[14.85px] shrink-0" aria-label="Assistant">
        {TOOLS.map((tool) => (
          <ToolRow key={tool.id} {...tool} />
        ))}
      </nav>

      <nav className="mt-[12px] shrink-0" aria-label="Projects">
        <GroupHeader label="Projects" icon={Plus} action="New project" />
        {PROJECTS.map((name) => (
          <ToolRow
            key={name}
            id={name}
            label={name}
            icon={Folder}
            active={projectFilter === name}
            onClick={() => setProjectFilter((current) => (current === name ? null : name))}
          />
        ))}
      </nav>

      <div className="mt-[12px] shrink-0">
        <GroupHeader label="Chats and tasks" icon={SlidersHorizontal} action="Filter chats" />
      </div>

      {/* the list is the only thing here that can grow, so it is the only
          thing that scrolls — `min-h-0` or a flex child runs past the card and
          paints over the divider and the trial pill below it */}
      <div
        role="list"
        aria-label="Chats and tasks"
        className="min-h-0 flex-1 overflow-y-auto pb-[4px]"
      >
        {projectFilter ? (
          <div
            data-agent-project-filter={projectFilter}
            className="flex h-[28px] items-center gap-1 px-[8px] text-[11px] text-plane-muted"
          >
            <span className="truncate">Project: {projectFilter}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear project filter"
              onClick={() => setProjectFilter(null)}
              className="ml-auto text-plane-faint"
            >
              <X aria-hidden className="size-[13px]" />
            </Button>
          </div>
        ) : null}
        {groups.length === 0
          ? filteredChats.map(renderChat)
          : [
              ...groupedChats.map(({ group, chats: groupChats }) => (
                <ChatSection key={group} label={group}>
                  {groupChats.length > 0 ? groupChats.map(renderChat) : (
                    <p className="px-[8px] py-1 text-[12px] text-plane-faint">No chats in this group</p>
                  )}
                </ChatSection>
              )),
              <ChatSection key="ungrouped" label="Ungrouped">
                {ungroupedChats.length > 0 ? ungroupedChats.map(renderChat) : (
                  <p className="px-[8px] py-1 text-[12px] text-plane-faint">No ungrouped chats</p>
                )}
              </ChatSection>,
            ]}
        {archivedChats.length > 0 ? (
          <div className="mt-[8px] border-t border-plane-border pt-[8px]">
            <Button
              variant="nav"
              aria-expanded={showArchived}
              aria-controls="archived-ai-chats"
              onClick={() => setShowArchived((open) => !open)}
              className={cn(ROW, "justify-between text-plane-muted")}
            >
              <span className="flex min-w-0 items-center">
                <Archive aria-hidden {...GLYPH} className="shrink-0 text-plane-faint" />
                <span className="ml-[6px] truncate">Archived</span>
              </span>
              <span className="text-[12px] tabular-nums text-plane-faint">{archivedChats.length}</span>
            </Button>
            {showArchived ? (
              <div id="archived-ai-chats" className="mt-[4px]" role="list" aria-label="Archived chats">
                {archivedChats.map((chat) => (
                  <div
                    key={chat.id}
                    role="listitem"
                    data-agent-archived-chat={chat.id}
                    className={cn(ROW, "text-plane-muted")}
                  >
                    <Archive aria-hidden {...GLYPH} className="shrink-0 text-plane-faint" />
                    <span className="ml-[6px] min-w-0 flex-1 truncate">{chat.title}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Restore ${chat.title}`}
                      onClick={() => unarchiveChat(chat.id)}
                      className="ml-1 text-plane-faint"
                    >
                      <Archive aria-hidden className="size-[13px]" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {copiedId ? (
        <p role="status" className="sr-only">
          Session ID copied
        </p>
      ) : null}
      {quickTaskChat ? (
        <QuickTaskPanel
          chat={quickTaskChat}
          preview={messages[quickTaskChat.id]?.at(-1)?.content}
          open
          onClose={() => setQuickTaskChatId(null)}
          onOpenChat={() => {
            openChat(quickTaskChat.id);
            setQuickTaskChatId(null);
          }}
        />
      ) : null}
      <CreateGroupDialog
        open={createGroupOpen}
        onOpenChange={setCreateGroupOpen}
        onCreate={createGroup}
      />
    </div>
  );
}
