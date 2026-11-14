"use client";

import {
  animate,
  motion,
  motionValue,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

import {
  DURATION,
  SHIFT,
  exitDuration,
  timing,
  useReduced,
} from "@/lib/motion-tokens";
import { cn } from "@/lib/utils";

/**
 * SideTabs — four labelled handles hanging inward from the chat card's right
 * edge, each one a browser tab turned on its side: the base, with its two
 * concave flares, sits on the card's right border and the rounded end reaches
 * left into the chat. Each carries its name written down the tab (top to
 * bottom), and each is a toggle for a small panel of its own.
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
 *
 * ── Opening a tab ────────────────────────────────────────────────────────────
 * Pressing a tab slides its panel in from the card's right border, over the
 * chat, and the tab rides along on the panel's left edge: tab and panel are
 * translated by ONE motion value, so they cannot drift apart mid-slide. Once
 * the tab is off its resting place its base column is the panel's left border,
 * and a second fill, closed across that column, hides the border between the
 * flares — the tab opens into its page the way a browser tab does. The other
 * three tabs fade and tuck into the border. Pressing the tab again, or Escape,
 * runs it all back.
 */

/** how far a tab reaches into the card past the inner edge of its border, in px */
export const SIDE_TAB_REACH = 34;
/** the tab's body, end to end along the card edge (flares not included) */
const LENGTH = 124;
/** radius of the two rounded inner corners */
const END = 12;
/** radius of the two concave flares where the tab meets the card border */
const FLARE = 8;
/** the handles, top to bottom */
export const SIDE_TAB_LABELS = [
  "Knowledge base",
  "References",
  "World Labs",
  "Force graph",
] as const;
export type SideTabLabel = (typeof SIDE_TAB_LABELS)[number];

/** the box: the reach, plus the card's 1px border column on the right */
const W = SIDE_TAB_REACH + 1;
/** the box: the body plus a flare at each end */
const H = LENGTH + 2 * FLARE;

const b = W - 0.5; // centre of the card's border column
const tip = 0.5; // centre of the end's stroke column
const top = FLARE + 0.5; // centre of the top side's stroke row
const bottom = FLARE + LENGTH - 0.5; // centre of the bottom side's stroke row
/** the label's centre line: midway between the rounded end and the border */
const LABEL_X = (tip + (W - 1)) / 2;

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
 * The same edge closed one column further out, across the border itself: drawn
 * only while the tab rides a panel, where that column is the panel's left
 * border and covering it between the flares is what joins tab and page.
 */
const ATTACHED = `${OUTLINE} L ${W} ${bottom + FLARE} L ${W} ${top - FLARE} Z`;

/**
 * The outline grey: the New button's border and the rail hairline, a step
 * darker than the card's own #EAEBEC border so a white tab on a white card
 * still reads as a shape. The panel's outline is the same grey, so the flares
 * melt into it.
 */
const OUTLINE_GREY = "#D6D7D9";

/** the panel's width, and the most of the card it may cover on a narrow window */
const PANEL_WIDTH = 320;
const PANEL_MAX_SHARE = 0.45;
/** the panel's left corners */
const PANEL_RADIUS = 8;

/**
 * Seconds. The slide is the one long move here: it carries a 320px surface,
 * further than anything else in the app travels, so it gets more than
 * DURATION.move. It closes at the app's exit ratio; the other tabs fade on
 * the existing section/move durations.
 */
const SLIDE = 0.28;
const SLIDE_BACK = exitDuration(SLIDE);
const FADE_OUT = DURATION.section;
const FADE_IN = DURATION.move;

/** no native scrollbar, should a panel ever scroll */
const NO_SCROLLBAR =
  "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";

export function SideTabs({ className }: { className?: string }) {
  const reduce = useReduced();
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  /** the tab whose panel is open */
  const [open, setOpen] = useState<SideTabLabel | null>(null);
  /** panels in the DOM: the open one, plus any still sliding home */
  const [present, setPresent] = useState<SideTabLabel[]>([]);
  const [panelWidth, setPanelWidth] = useState(PANEL_WIDTH);
  /** each tab's horizontal offset from its resting place; its panel shares it */
  const [offsets] = useState(
    () =>
      Object.fromEntries(SIDE_TAB_LABELS.map((label) => [label, motionValue(0)])) as Record<
        SideTabLabel,
        MotionValue<number>
      >,
  );
  /** `open` as of the last toggle, for animation callbacks that outlive a render */
  const openRef = useRef(open);
  const widthRef = useRef(panelWidth);

  /** where a tab sits when `next` is the open one */
  const restFor = (label: SideTabLabel, next: SideTabLabel | null, width: number) =>
    next === null ? 0 : label === next ? -width : SHIFT.body;

  function show(next: SideTabLabel | null) {
    openRef.current = next;
    setOpen(next);
    if (next) setPresent((p) => (p.includes(next) ? p : [...p, next]));

    for (const label of SIDE_TAB_LABELS) {
      const x = offsets[label];
      const target = restFor(label, next, widthRef.current);
      /* a panel leaves the DOM once its tab is home and it is not the open one */
      const settle = () => {
        if (openRef.current === label) return;
        setPresent((p) => (p.includes(label) ? p.filter((l) => l !== label) : p));
      };
      if (reduce) {
        x.jump(target);
        settle();
        continue;
      }
      const duration =
        label === next ? SLIDE : x.get() < 0 ? SLIDE_BACK : target > 0 ? FADE_OUT : FADE_IN;
      animate(x, target, { ...timing(duration, reduce), onComplete: settle });
    }
  }

  const toggle = (label: SideTabLabel) => show(open === label ? null : label);

  /* Escape closes whatever is open */
  useEffect(() => {
    if (open === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) show(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  /* The panel's width follows the card's: 320px, but never more than 45% of
     it. Measured off the content column, whose content box is the card. A
     resize while a panel is open moves its tab with it, without a slide. */
  useEffect(() => {
    const column = rootRef.current?.parentElement;
    if (!column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.min(
        PANEL_WIDTH,
        Math.floor(entry.contentRect.width * PANEL_MAX_SHARE),
      );
      if (width === widthRef.current) return;
      widthRef.current = width;
      setPanelWidth(width);
      const current = openRef.current;
      if (current) offsets[current].jump(-width);
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, [offsets]);

  return (
    <div
      ref={rootRef}
      data-side-tabs=""
      /* Inert to the pointer everywhere but a tab or a panel: the chat between
         and around them still scrolls, selects and clicks. */
      className={cn("pointer-events-none", className)}
      style={{ width: W }}
    >
      {/* The panels' window: from the stack's left out to the card border's
          inner edge, so a panel slides out of the border rather than over the
          gutter. It starts one corner radius above the stack, so the panel's
          rounded corner is done before the top tab's flare begins. */}
      <div
        className="absolute right-px bottom-0 overflow-hidden"
        style={{ top: -PANEL_RADIUS, width: panelWidth }}
      >
        {present.map((label) => (
          <SideTabPanel
            key={label}
            id={`${id}-panel-${SIDE_TAB_LABELS.indexOf(label)}`}
            label={label}
            offset={offsets[label]}
            width={panelWidth}
            open={open === label}
          />
        ))}
      </div>
      {/* A column that wraps into a second, clipped column: on a viewport too
          short for all four, the ones that don't fit drop out whole instead
          of being cut through the middle. Clipped on the right only (the
          negative left inset), so a tab riding a panel stays visible. After
          the panels in the tree, so a riding tab covers the panel's border. */}
      <div
        className="relative flex h-full flex-col flex-wrap gap-2"
        style={{ clipPath: "inset(0 0 0 -100vmax)" }}
      >
        {SIDE_TAB_LABELS.map((label, index) => (
          <SideTab
            key={label}
            label={label}
            offset={offsets[label]}
            expanded={open === label}
            hidden={open !== null && open !== label}
            controls={present.includes(label) ? `${id}-panel-${index}` : undefined}
            reduce={reduce}
            onToggle={() => toggle(label)}
          />
        ))}
      </div>
    </div>
  );
}

function SideTab({
  label,
  offset,
  expanded,
  hidden,
  controls,
  reduce,
  onToggle,
}: {
  label: SideTabLabel;
  offset: MotionValue<number>;
  expanded: boolean;
  hidden: boolean;
  controls: string | undefined;
  reduce: boolean;
  onToggle: () => void;
}) {
  /* off its resting place, leftward, means riding a panel */
  const attached = useTransform(offset, (x) => (x < 0 ? 1 : 0));

  return (
    <motion.button
      type="button"
      data-side-tab=""
      aria-expanded={expanded}
      aria-controls={controls}
      aria-hidden={hidden || undefined}
      inert={hidden}
      tabIndex={hidden ? -1 : undefined}
      onClick={onToggle}
      initial={false}
      animate={{ opacity: hidden ? 0 : 1 }}
      transition={timing(hidden ? FADE_OUT : FADE_IN, reduce)}
      style={{ x: offset, width: W, height: H }}
      className={cn(
        "group block shrink-0 cursor-pointer select-none",
        "focus-visible:outline-none",
        hidden ? "pointer-events-none" : "pointer-events-auto",
      )}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block">
        <path d={BODY} className="fill-plane-pane" />
        <motion.path d={ATTACHED} className="fill-plane-pane" style={{ opacity: attached }} />
        <path
          d={OUTLINE}
          className="fill-none group-focus-visible:stroke-plane-ink-2"
          stroke={OUTLINE_GREY}
          strokeWidth={1}
        />
        {/* the name, written down the tab and centred in its body */}
        <text
          x={LABEL_X}
          y={H / 2}
          transform={`rotate(90 ${LABEL_X} ${H / 2})`}
          textAnchor="middle"
          dominantBaseline="central"
          className={cn(
            "text-[13px] group-hover:fill-plane-ink",
            expanded ? "fill-plane-ink" : "fill-plane-ink-2",
          )}
        >
          {label}
        </text>
      </svg>
    </motion.button>
  );
}

function SideTabPanel({
  id,
  label,
  offset,
  width,
  open,
}: {
  id: string;
  label: SideTabLabel;
  offset: MotionValue<number>;
  width: number;
  open: boolean;
}) {
  return (
    /* Parked just past the window's right edge, then carried in by its tab's
       offset: at -width it fills the window exactly, its left border on the
       tab's base column. Its right side is the card's own border. */
    <motion.section
      id={id}
      data-side-tab-panel={label}
      aria-labelledby={`${id}-title`}
      aria-hidden={open ? undefined : true}
      inert={!open}
      className={cn(
        "pointer-events-auto absolute top-0 bottom-0 left-full overflow-y-auto",
        "border border-r-0 bg-plane-pane px-4 pt-3.5 pb-4",
        NO_SCROLLBAR,
      )}
      style={{
        x: offset,
        width,
        borderColor: OUTLINE_GREY,
        borderTopLeftRadius: PANEL_RADIUS,
        borderBottomLeftRadius: PANEL_RADIUS,
      }}
    >
      <h2 id={`${id}-title`} className="text-[13px] leading-5 font-semibold text-plane-ink">
        {label}
      </h2>
    </motion.section>
  );
}
