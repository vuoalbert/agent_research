import { ChevronDown, Search } from "lucide-react";

import { RibbonSquare } from "@/components/brand/ribbon";
import { Input } from "@/components/ui/input";

/**
 * TOP BAR — owned by the top-bar agent (see CONTRACT.md §4/§5).
 *
 * Box: 1440 x 40, bg --plane-page, and it draws NO bottom border: the 1px line
 * at y=40 belongs to the rail/sidebar (border-t) and to the content card's own
 * top border. Adding one here would double-draw it.
 *
 * Every number is measured off reference/target-1440x900@2x.png at dpr 2, then
 * confirmed by re-capturing this component and pixel-diffing the 1440x40 strip.
 * Radii were fitted by rendering calibration rects in the same Chrome and
 * matching the corner-inset profile row for row: 6px workspace square, 6px
 * "Get started", 8px search field.
 *
 * Boxes and ink spans (CSS px):
 *   18..44       workspace tile (26px, r6) — carries the folded-ribbon mark
 *                knocked out of it, in place of Plane's white "S" on blue
 *   52.5..172.5  workspace name ink — 14px/500 #0F0F10
 *   180.5..189.5 chevron-down ink — lucide, 16px, #5D6265
 *   538..902     search field (h 28, y 6..34, #fff, 1px #E1E2E3, r8)
 *     548..559.5   magnifier ink — lucide search, 12.5px, #494D50
 *     569.5..611.5 "Search" placeholder ink — 13px/450 #494D50
 *
 * The workspace switcher is back — this is the slot the logo was always coming
 * back to (see "feat: remove top-bar workspace switcher"). Its geometry is the
 * measured one, restored unchanged: the tile's 26px box, the 8px gap to the
 * name, 14px/500 ink, and the chevron 4.5px after that. The tile's radius was
 * re-checked against the reference's corner-inset profile before restoring it
 * — 0.5px in at 3px down, flush by 4.5px down, which is r6 to within 0.3px.
 *
 * Two things did change. The tile is no longer `--plane-brand` blue: it is the
 * mark's own black, and the ribbon is knocked out of it rather than sat on it.
 * And it is inert — a plain box, not a button, because there is no menu behind
 * it yet and a focusable control that does nothing is worse than none.
 *
 * Plane's right-hand cluster stays gone ("Get started", the inbox and help
 * icons, "AI assistant" and the avatar, x 1124.5..1427).
 *
 * The search field is unmoved at its measured x 538..902, y 6..34: it was
 * never positioned relative to either cluster, only to the viewport centre.
 *
 * The reference's sub-pixel nudges do not survive: they positioned glyphs
 * *inside* Plane's tile and button, and this mark is the tile.
 */

/**
 * A placeholder label for the workspace switcher.
 */
const WORKSPACE_LABEL = "Workspace";
export function TopBar() {
  return (
    <header
      data-region="top-bar"
      className="relative h-10 w-full bg-plane-page"
    >
      {/* ── left: workspace switcher ─────────────────────────────────────── */}
      <div
        data-topbar-workspace
        className="absolute top-0 left-[18px] flex h-10 items-center"
      >
        {/* No half-pixel nudge here. The reference lifts the glyph *inside*
            Plane's tile by 0.5px; our ribbon is knocked out of the tile, so
            there is no separate glyph to lift, and nudging the tile itself
            would move the measured 26px box off y 7..33. */}
        <span aria-hidden className="flex text-plane-ink">
          <RibbonSquare size={26} radius={6} />
        </span>
        <span className="ml-[8px] text-[14px] font-medium text-plane-ink">
          {WORKSPACE_LABEL}
        </span>
        <ChevronDown aria-hidden className="ml-[4.5px] size-4 text-[#5D6265]" />
      </div>

      {/* ── centre: search ───────────────────────────────────────────────── */}
      <div className="absolute top-[6px] left-1/2 h-[28px] w-[364px] -translate-x-1/2">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-[6.75px] left-[8.75px] size-[12.5px] text-plane-muted"
        />
        <Input
          type="text"
          aria-label="Search"
          placeholder="Search"
          className="h-[28px] rounded-[8px] border-[#E1E2E3] bg-plane-pane py-0 pr-[8px] pl-[29.75px] text-[13px] font-[450] text-plane-ink placeholder:text-plane-muted md:text-[13px]"
        />
      </div>

    </header>
  );
}

