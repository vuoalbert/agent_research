"use client";

/**
 * What the composer's `+` opens.
 *
 * The `+` stands where a paperclip usually does, and that is the honest place
 * for it: attaching a file is one of eight things this menu offers, and a
 * paperclip standing for all eight would be a glyph lying about its own list.
 *
 * Built on the repo's existing shadcn `DropdownMenu` (Base UI, not Radix) — no
 * new primitive, because the pane already needs a menu grammar and the toolbar's
 * "…" is drawn with this one.
 *
 * One of the eight does something: **Add files or photos** opens a real file
 * picker (⌘U while the composer has focus does the same). The rest are inert and
 * say so by doing nothing at all rather than by being disabled — a greyed row
 * reads as "not now", and these are "not yet". **Web search** keeps its tick as
 * local state, because it is the one row whose *appearance* is a claim about the
 * app's own settings, and a tick that could never be off would be decoration.
 *
 * ── Two Base UI findings, both load-bearing ──────────────────────────────────
 * - `DropdownMenuContent` in this repo is `w-(--anchor-width)`, which is the
 *   *trigger's* width. Anchored to a 32px button that is a 32px menu. Hence the
 *   explicit `w-auto min-w-[264px]`.
 * - `DropdownMenuSubTrigger` does not open on hover in this version unless
 *   asked. Without `openOnHover`, moving the pointer onto "Skills" takes the
 *   whole menu down instead of opening the flyout.
 */

import {
  Archive,
  BookOpen,
  Camera,
  Check,
  Globe,
  LayoutGrid,
  Paperclip,
  Puzzle,
  Telescope,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** The panel. 12px to match everything else on this screen — the composer, the
 *  cards, the empty slots — rather than the menu's default 8. */
const PANEL =
  "w-auto min-w-[264px] rounded-[12px] border border-plane-border bg-white p-1 ring-0 shadow-[0_1px_2px_rgba(15,15,16,0.04),0_12px_32px_rgba(15,15,16,0.10)]";

/** One row, one wash, one grey — the keyboard's row takes the same fill as the
 *  pointer's rather than a second box in a second colour arriving late. */
const ROW = cn(
  "flex cursor-default items-center gap-2 rounded-[7px] px-2 py-[7px]",
  "text-[13px] leading-none text-[var(--ai-ink)] outline-none transition-colors",
  "data-highlighted:bg-[var(--ai-tint)] data-popup-open:bg-[var(--ai-tint)]",
);

/** The four skills the composer can reach for. */
export const SKILLS = [
  "Create an event",
  "Draft a document",
  "Plan a project",
  "Research a topic",
] as const;

/** What this workspace has connected. */
export const CONNECTORS = [
  "Google Calendar",
  "Google Drive",
  "Gmail",
  "Notion",
] as const;

/** The one project there is. */
export const PROJECTS = ["How Agent Research works"] as const;

function Glyph({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <Icon
      aria-hidden
      size={15}
      strokeWidth={1.75}
      className="shrink-0 text-[var(--ai-muted)]"
    />
  );
}

/** A leaf row: glyph, label, and whatever sits at its right end. */
function Row({
  icon,
  label,
  shortcut,
  trailing,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  trailing?: ReactNode;
  onSelect?: () => void;
}) {
  return (
    <DropdownMenuItem className={ROW} onClick={onSelect}>
      <Glyph icon={icon} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
      {shortcut ? (
        <span
          aria-hidden
          className="shrink-0 pl-3 text-[11.5px] font-medium tracking-wide text-[var(--ai-muted)]"
        >
          {shortcut}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}

/** A row that opens a panel of its own. */
function Flyout({
  icon,
  label,
  items,
}: {
  icon: LucideIcon;
  label: string;
  items: readonly string[];
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        openOnHover
        className={cn(
          ROW,
          // The trigger draws its own chevron; this is that chevron in the
          // pane's muted grey rather than a second one added beside it.
          "[&>svg:last-child]:ml-auto [&>svg:last-child]:size-3.5 [&>svg:last-child]:text-[var(--ai-muted)]",
        )}
      >
        <Glyph icon={icon} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className={cn(PANEL, "min-w-[184px]")}
        sideOffset={6}
      >
        {items.map((item) => (
          <DropdownMenuItem key={item} className={ROW}>
            <span className="min-w-0 flex-1 truncate">{item}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function AiPlusMenu({
  children,
  onAddFiles,
}: {
  /** The `+` itself, so the composer keeps ownership of its own button. */
  children: ReactElement;
  onAddFiles: () => void;
}) {
  const [webSearch, setWebSearch] = useState(true);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={children} />
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className={PANEL}
      >
        <Row
          icon={Paperclip}
          label="Add files or photos"
          shortcut="⌘U"
          onSelect={onAddFiles}
        />
        <Row icon={Camera} label="Take a screenshot" />
        <Flyout icon={Archive} label="Add to project" items={PROJECTS} />

        <DropdownMenuSeparator className="-mx-0.5 my-1 bg-plane-border" />

        <Flyout icon={BookOpen} label="Skills" items={SKILLS} />
        <Flyout icon={LayoutGrid} label="Add connector" items={CONNECTORS} />
        <Row icon={Puzzle} label="Add plugins" />

        <DropdownMenuSeparator className="-mx-0.5 my-1 bg-plane-border" />

        <Row icon={Telescope} label="Research" />
        <Row
          icon={Globe}
          label="Web search"
          onSelect={() => setWebSearch((on) => !on)}
          trailing={
            /* Ink on white — never a colour, and never blue. A state this quiet
               is what the whole palette is for. */
            webSearch ? (
              <Check
                aria-label="Web search on"
                size={15}
                strokeWidth={2}
                className="shrink-0 text-[var(--ai-ink)]"
              />
            ) : null
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
