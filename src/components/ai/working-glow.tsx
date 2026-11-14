"use client";

/**
 * THE WORKING GLOW — the AI card's edge lights up while a reply is arriving.
 *
 * Three layers in one `pointer-events: none` overlay over the card, mounted
 * only while `working` and faded out over `WORKING.fade` when it ends:
 *
 * - **a faint ring** just inside the card's 1px border, the whole way round:
 *   the card's edge, tinted. It is also everything a reduced-motion reader gets
 *   — a static accent border, no travel.
 * - **a light travelling round it**: a conic gradient (blue head, violet tail,
 *   clear the rest of the lap) on a square that is spun with `transform` and
 *   seen only through the ring's mask. A transform on its own layer, so the
 *   lap runs on the compositor with no paint and no React render per frame.
 * - **a breath**: a soft inset glow whose `opacity` rises and falls. Inset, so
 *   it never reaches the text in the middle of the card, and opacity only, so
 *   it never repaints.
 *
 * Nothing here is in flow — the overlay is absolutely positioned over the card
 * — so the card's box and its text are identical before, during and after.
 * Not red: red is the colour of a contradiction on this app, and nothing else
 * may use it.
 *
 * Canvas UI (HTML-in-Canvas effects) was the first idea; its API is not in
 * Chrome before 157 without a flag, and none of its effects is a calm border
 * signal, so this is plain CSS.
 */

import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties } from "react";

import { EASE, WORKING, useReduced } from "@/lib/motion-tokens";

/** the ring's width, just inside the card's own 1px border */
const RING = 1.5;

/* The two cool hues of the subagent shapes in the thread (`SHAPE_COLOR` in
   `subagents-block.tsx`: the square's #6B8AFD and the diamond's #A47AE6), so
   the card's edge and the research tree read as one palette, not two. */

/** blue at the head, violet in the tail, clear for the rest of the lap */
const SWEEP_GRADIENT =
  "conic-gradient(from 0turn, transparent 0turn, transparent 0.5turn, rgba(164, 122, 230, 0.34) 0.8turn, rgba(107, 138, 253, 0.85) 0.97turn, transparent 1turn)";

/** the whole ring, faintly — the static accent under reduced motion */
const RING_TINT = "rgba(107, 138, 253, 0.18)";

/** the breath's inner glow */
const BREATH_SHADOW = "inset 0 0 28px rgba(107, 138, 253, 0.10)";

/** shows only the ring: the padding box minus the content box */
const ringMask: CSSProperties = {
  padding: RING,
  mask: "linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)",
  WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
  WebkitMaskComposite: "xor",
};

export function WorkingGlow({ working }: { working: boolean }) {
  const reduce = useReduced();
  const fade = reduce ? { duration: 0 } : { duration: WORKING.fade, ease: EASE };

  return (
    <AnimatePresence initial={false}>
      {working ? (
        <motion.div
          key="working-glow"
          data-ai="working-glow"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fade}
          /* the card's inner corners: 8px outside, less its 1px border */
          className="pointer-events-none absolute inset-0 z-20 rounded-r-[7px]"
        >
          <div
            data-ai="working-ring"
            className="absolute inset-0 overflow-hidden rounded-[inherit] [container-type:size]"
            style={ringMask}
          >
            <div className="absolute inset-0" style={{ background: RING_TINT }} />
            {/* a square wide enough that its corners never show inside the
                card as it turns: the card's longer side times √2 */}
            <div
              data-ai="working-sweep"
              className="absolute left-1/2 top-1/2 aspect-square w-[calc(max(100cqw,100cqh)*1.42)] -translate-x-1/2 -translate-y-1/2 animate-spin will-change-transform motion-reduce:hidden"
              style={{ background: SWEEP_GRADIENT, animationDuration: `${WORKING.sweep}s` }}
            />
          </div>
          <div
            data-ai="working-breath"
            className="absolute inset-0 animate-pulse rounded-[inherit] motion-reduce:animate-none motion-reduce:opacity-0"
            style={{ boxShadow: BREATH_SHADOW, animationDuration: `${WORKING.breath}s` }}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
