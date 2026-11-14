import { cn } from "@/lib/utils";

/**
 * SideTabs — four blank handles on the chat card's right edge, each one a
 * browser tab turned on its side: the base, with its two concave flares,
 * melts into the card's right border and the rounded end reaches out into the
 * page gutter. Decoration only for now: no labels, no behaviour.
 *
 * One tab, in its own SVG box (x → out of the card, y ↓ down the edge):
 *
 *        x=0.5 (the card border's centre line)
 *          |
 *    y0  - )                 flare: radius FLARE, centred outside the tab
 *           \_____________
 *                         `.   end: radius END
 *                          |   LENGTH of straight-ish body, REACH px out
 *            _____________.'
 *           /
 *          )                  flare
 *
 * The box starts one pixel inside the card, on top of the card's 1px right
 * border, so that:
 *   - the fill (the card's white) paints over that border along the whole
 *     joint, and the line never shows across the tab's base;
 *   - the outline starts on the border's centre line with a vertical tangent,
 *     so the card's border runs straight into the flare with no step.
 * Straight segments sit on half pixels so a 1px stroke lands on whole pixels.
 */

/** how far a tab sticks out past the card's right edge, in px */
export const SIDE_TAB_REACH = 28;
/** the tab's body, end to end along the card edge (flares not included) */
const LENGTH = 104;
/** radius of the two rounded outer corners */
const END = 10;
/** radius of the two concave flares where the tab meets the card */
const FLARE = 8;
/** how many handles */
const COUNT = 4;

/** the box: one pixel over the card border, plus the reach */
const W = 1 + SIDE_TAB_REACH;
/** the box: the body plus a flare at each end */
const H = LENGTH + 2 * FLARE;

const c = 0.5; // centre of the card's border column
const tip = W - 0.5; // centre of the end's stroke column
const top = FLARE + 0.5; // centre of the top side's stroke row
const bottom = FLARE + LENGTH - 0.5; // centre of the bottom side's stroke row

/** the visible edge: flare, side, round end, side, flare — open at the base */
const OUTLINE = [
  `M ${c} ${top - FLARE}`,
  `A ${FLARE} ${FLARE} 0 0 0 ${c + FLARE} ${top}`,
  `L ${tip - END} ${top}`,
  `A ${END} ${END} 0 0 1 ${tip} ${top + END}`,
  `L ${tip} ${bottom - END}`,
  `A ${END} ${END} 0 0 1 ${tip - END} ${bottom}`,
  `L ${c + FLARE} ${bottom}`,
  `A ${FLARE} ${FLARE} 0 0 0 ${c} ${bottom + FLARE}`,
].join(" ");

/** the same edge closed down the box's left side, over the card's border */
const BODY = `${OUTLINE} L 0 ${bottom + FLARE} L 0 ${top - FLARE} Z`;

export function SideTabs({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      data-side-tabs=""
      /* A column that wraps into a second, clipped column: on a viewport too
         short for all four, the ones that don't fit drop out whole instead
         of being cut through the middle. */
      className={cn("flex flex-col flex-wrap gap-1 overflow-hidden", className)}
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
            className="fill-none stroke-plane-border"
            strokeWidth={1}
          />
        </svg>
      ))}
    </div>
  );
}
