import { cn } from "@/lib/utils";

/**
 * SideTabs — four blank handles hanging inward from the chat card's right
 * edge, each one a browser tab turned on its side: the base, with its two
 * concave flares, sits on the card's right border and the rounded end reaches
 * left into the chat. Decoration only for now: no labels, no behaviour.
 *
 * One tab, in its own SVG box (x → toward the card's right edge, y ↓ down it):
 *
 *                           x = W-0.5, the card border's centre line
 *                               |
 *                               |  y0
 *                             _/   flare: radius FLARE, centred outside the tab
 *          .-----------------'
 *         /                        end: radius END
 *        |                         LENGTH along the edge, REACH px into the card
 *         \
 *          `-----------------.
 *                             ‾\   flare
 *                               |
 *
 * The box's right column is the card's 1px right border, so that:
 *   - each flare starts on the border's centre line with a vertical tangent and
 *     peels off it, the way a browser tab's flares melt into the toolbar;
 *   - the fill stops at the border's inner edge, so the card's own border runs
 *     on, unbroken, behind every tab's base.
 * The fill is the card's white and hides whatever scrolls under the tab.
 * Straight segments sit on half pixels so a 1px stroke lands on whole pixels.
 */

/** how far a tab reaches into the card past the inner edge of its border, in px */
export const SIDE_TAB_REACH = 34;
/** the tab's body, end to end along the card edge (flares not included) */
const LENGTH = 200;
/** radius of the two rounded inner corners */
const END = 8;
/** radius of the two concave flares where the tab meets the card border */
const FLARE = 8;
/** how many handles */
const COUNT = 4;

/** the box: the reach, plus the card's 1px border column on the right */
const W = SIDE_TAB_REACH + 1;
/** the box: the body plus a flare at each end */
const H = LENGTH + 2 * FLARE;

const b = W - 0.5; // centre of the card's border column
const tip = 0.5; // centre of the end's stroke column
const top = FLARE + 0.5; // centre of the top side's stroke row
const bottom = FLARE + LENGTH - 0.5; // centre of the bottom side's stroke row

/** the visible edge: flare, side, round end, side, flare — open at the base */
const OUTLINE = [
  `M ${b} ${top - FLARE}`,
  `A ${FLARE} ${FLARE} 0 0 1 ${b - FLARE} ${top}`,
  `L ${tip + END} ${top}`,
  `A ${END} ${END} 0 0 0 ${tip} ${top + END}`,
  `L ${tip} ${bottom - END}`,
  `A ${END} ${END} 0 0 0 ${tip + END} ${bottom}`,
  `L ${b - FLARE} ${bottom}`,
  `A ${FLARE} ${FLARE} 0 0 1 ${b} ${bottom + FLARE}`,
].join(" ");

/** the same edge closed along the border's inner edge, leaving the border be */
const BODY = `${OUTLINE} L ${W - 1} ${bottom + FLARE} L ${W - 1} ${top - FLARE} Z`;

/**
 * The outline grey: the New button's border and the rail hairline, a step
 * darker than the card's own #EAEBEC border so a white tab on a white card
 * still reads as a shape.
 */
const OUTLINE_GREY = "stroke-[#D6D7D9]";

export function SideTabs({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      data-side-tabs=""
      /* A column that wraps into a second, clipped column: on a viewport too
         short for all four, the ones that don't fit drop out whole instead
         of being cut through the middle. Inert to the pointer: the chat under
         a tab still scrolls, selects and clicks. */
      className={cn(
        "pointer-events-none flex flex-col flex-wrap gap-1 overflow-hidden",
        className,
      )}
      style={{ width: W }}
    >
      {Array.from({ length: COUNT }, (_, i) => (
        <svg
          key={i}
          data-side-tab=""
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="block shrink-0"
        >
          <path d={BODY} className="fill-plane-pane" />
          <path
            d={OUTLINE}
            className={cn("fill-none", OUTLINE_GREY)}
            strokeWidth={1}
          />
        </svg>
      ))}
    </div>
  );
}
