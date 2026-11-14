"use client";

import { CirclePlus, PanelLeft, Plus, type LucideIcon } from "lucide-react";
import type { SVGProps } from "react";
import { NEW_BUTTON, NEW_GLYPH } from "@/data/nav";
import { AiSidebar } from "@/components/sidebars/ai-sidebar";
import { Button } from "@/components/ui/button";
import type { View } from "@/lib/navigation";

/**
 * Sidebar — the white card between the icon rail and the content card.
 *
 * The card is **x 60..310, y 40..892** with a 1px `--plane-border` top / left /
 * bottom border and an 8px radius on its left corners only. It takes the x=60
 * seam (`-ml-px w-[250px]`) and draws no `border-r`: x=310 is the content
 * card's left border.
 *
 * Vertical rhythm (page y): header 58.8..82.8 (the active app's name, plus the
 * sliders / panel buttons), "New" button 97..129, then the AI chat list.
 */

const ROW_ICON_PX = 16;

/** Sidebar glyphs are flat 16px lucide outlines. */
const outline = {
  width: ROW_ICON_PX,
  height: ROW_ICON_PX,
  strokeWidth: 2,
} as const;

/** the "New" button's marks (NEW_GLYPH in data/nav.ts) */
const ICONS: Record<string, LucideIcon> = {
  Plus,
  CirclePlus,
};

/** Header "preferences" glyph: three rules with full-height handles. */
function SlidersMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M21 4.5h-6.5M10.5 4.5H3M21 12h-8.5M8.5 12H3M21 19.5h-4.5M12.5 19.5H3" />
      <path d="M14.5 1.5v6M8.5 9v6M16.5 16.5v6" />
    </svg>
  );
}

export function Sidebar({ view }: { view: View }) {
  const newGlyphName = NEW_GLYPH[view.app] ?? "Plus";
  const NewGlyph = ICONS[newGlyphName] ?? Plus;
  return (
    <aside
      data-region="sidebar"
      className="-ml-px flex h-full w-[250px] flex-col rounded-l-[8px] border-y border-l border-plane-border bg-plane-pane px-[12px]"
    >
      {/* header — the two buttons centre on y 70.8 */}
      <div className="mt-[17.83px] flex h-[24px] shrink-0 items-center justify-between pr-[8px] pl-[8px]">
        <h2
          data-sidebar-title
          className="relative top-[1.5px] text-[16.4px] leading-[24px] font-semibold tracking-[-0.032em] text-plane-ink"
        >
          {view.app}
        </h2>
        <div className="flex items-center gap-[8.3px]">
          <Button
            variant="ghost"
            aria-label="Sidebar preferences"
            className="h-[24px] w-[24px] rounded-[6px] border-0 p-0 text-plane-ink-2 transition-none"
          >
            <SlidersMark aria-hidden />
          </Button>
          <Button
            variant="ghost"
            aria-label="Toggle sidebar"
            className="h-[24px] w-[24px] rounded-[6px] border-0 p-0 text-plane-ink-2 transition-none"
          >
            <PanelLeft aria-hidden width={16} height={16} strokeWidth={2} />
          </Button>
        </div>
      </div>

      {/* the outlined button: x 73..298, y 97..129 */}
      <Button
        variant="outline"
        data-sidebar-new
        className="mt-[14.17px] h-[32px] shrink-0 justify-start gap-0 rounded-[6px] border-[#D6D7D9] bg-plane-pane px-0 pl-[8px] text-[14.25px] font-normal text-plane-ink-2 shadow-[0_0_4px_rgba(16,24,40,0.035),0_1px_2px_rgba(16,24,40,0.028)] transition-none"
      >
        {/* a fixed 16px slot keeps the label from shifting */}
        <span className="relative flex h-[16px] w-[16px] shrink-0 items-center justify-center">
          <span className="absolute inset-0 flex items-center justify-center">
            <NewGlyph aria-hidden data-new-glyph={newGlyphName} {...outline} className="shrink-0" />
          </span>
        </span>
        <span className="ml-[3.6px]">{NEW_BUTTON}</span>
      </Button>

      {/* the AI chat list from the local agent store */}
      <div data-sidebar-body className="flex min-h-0 flex-1 flex-col">
        <AiSidebar />
      </div>
    </aside>
  );
}
