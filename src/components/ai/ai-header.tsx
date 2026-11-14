"use client";

/**
 * The AI app's 44px strip — the one that replaces `<ListHeader/>` inside the
 * content card.
 *
 * The shared list header is a work-items toolbar: a breadcrumb, a count pill, a
 * five-way layout switcher, Filter / Display / Analytics and a primary button.
 * None of the eight means anything to a conversation, and a toolbar of controls
 * that do nothing is worse than no toolbar. So this strip draws **at most one
 * thing**, and on the home screen it draws nothing at all.
 *
 * ── The two states ───────────────────────────────────────────────────────────
 * - **Home** (no conversation open): empty. Not a placeholder, not a faded
 *   title — the screen below it already says what this is, in a 400px brand
 *   mark, and a second label over it would be the app introducing itself twice.
 * - **Chat open**: the conversation's title, then a `ChevronDown`. Inert: there
 *   is no rename or delete menu behind it yet. It is drawn as one ghost `Button`
 *   rather than as text plus a glyph because the chevron is a promise about
 *   where a menu will go, and a chevron that is not part of a control is a
 *   chevron pointing at nothing.
 *
 * ── The geometry, which is not this file's to invent ─────────────────────────
 * The strip keeps `<ListHeader/>`'s box exactly — **h-44 including a 1px
 * `--plane-border` bottom hairline**, so the pane below it still starts at
 * y=85 and is still 806 tall (measured: card inner x 311..1431, y 41..891).
 * Nothing under this file may move because of what is in it.
 *
 * The title's ink starts at **x=340**, which is where the breadcrumb's first
 * glyph starts: `pl-[29px]` inside the card's inner left edge at 311, copied
 * from `list-header.tsx`. The `Button` recipe's own `px-2.5` is subtracted back
 * out with `-ml-2.5` so it is the *text* that lands on 340 and not the button's
 * box. (The brief estimated x≈475; the breadcrumb it names is measured at 340 in
 * this build, and matching the breadcrumb is the instruction the estimate was
 * standing in for.)
 */

import { ChevronDown } from "lucide-react";

import { FOCUS_RING } from "@/components/ai/tokens";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AiHeader({ title }: { title?: string }) {
  return (
    <div
      data-region="ai-header"
      data-state={title ? "chat" : "home"}
      /* No hairline under this strip, unlike <ListHeader/>'s. The rule there
         separates a toolbar from the rows it acts on; here the strip names the
         conversation below it and there is nothing to divide — a line would cut
         the title off the thread it belongs to. The 44px height is unchanged:
         the border was inside the border-box, so dropping it gives the content
         the pixel back rather than moving anything. */
      className="flex h-[44px] shrink-0 items-center bg-plane-pane pr-[20.5px] pl-[29px]"
    >
      {/* Switching chats updates this title in place. */}
      {title ? (
        <Button
          variant="ghost"
          data-ai="chat-title"
          className={cn(
            "-ml-2.5 h-[28px] max-w-[520px] gap-1 rounded-[6px] border-0 px-2.5",
            "text-[14px] leading-none font-medium text-plane-ink",
            "hover:bg-plane-page transition-none",
            FOCUS_RING,
          )}
        >
          <span className="min-w-0 truncate">{title}</span>
          <ChevronDown className="size-4 shrink-0 text-plane-muted" strokeWidth={2} />
        </Button>
      ) : null}
    </div>
  );
}
