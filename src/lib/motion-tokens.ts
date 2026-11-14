"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";

/**
 * Every duration, easing and spring in the app. One file so the motion can be
 * tuned as a system rather than component by component — a literal in a
 * component is a bug, and `src/__tests__/motion-tokens.test.ts` asserts these
 * values because they are calibration, not preference.
 */

/** ease-out: leaves quickly, settles rather than stops */
export const EASE = [0.32, 0.72, 0, 1] as const;

/** seconds */
export const DURATION = {
  /** 90ms — a menu closing, something leaving that nobody is watching */
  fast: 0.09,
  /** 120ms — a glyph swapping in place, a wash appearing */
  base: 0.12,
  /** 180ms — anything that travels: a pane, a crumb, a body */
  move: 0.18,
  /** 160ms — a section collapsing, a bubble arriving, a chat row appearing */
  section: 0.16,
} as const;

/**
 * The shared-element spring, for plates that slide between positions. Stiff
 * and heavily damped: it arrives without overshoot, because a plate that
 * bounced past its row would read as a different control.
 */
export const SPRING = {
  type: "spring",
  stiffness: 500,
  damping: 40,
  mass: 0.8,
} as const;

/**
 * Exits run at three quarters of their entrance. The thing arriving is what
 * the reader is looking for; the thing leaving should get out of the way.
 */
export const EXIT_RATIO = 0.75;
export const exitDuration = (enter: number) => enter * EXIT_RATIO;

/** px a surface travels on entry/exit */
export const SHIFT = {
  /** a breadcrumb segment or a chat title */
  crumb: 6,
  /** a whole body: the sidebar's, the content pane's, a thread */
  body: 8,
} as const;

/** seconds between staggered siblings, left to right */
export const STAGGER = 0.04;

/** a bubble arriving: it grows the last 2% rather than sliding */
export const POP_SCALE = 0.98;

/** a menu opening from its anchor corner */
export const MENU_SCALE = 0.96;

/** a tile acknowledging a press */
export const PRESS_SCALE = 0.96;

type Reduce = boolean | null;

/**
 * `useReducedMotion()` straight from Motion does not agree with itself across
 * hydration: the server renders one value and the client's first render the
 * other, so any prop derived from it mismatches and React re-renders the tree
 * complaining. Seen as a real hydration error on the rail, where it changed
 * `whileTap` and `transition` between server and client.
 *
 * Every surface uses this instead. It reports "not reduced" until after mount,
 * so the first client render matches the server, then switches to the user's
 * actual preference. A reduced-motion user sees at most one frame of the
 * animated version.
 */
export function useReduced(): boolean {
  const preference = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? Boolean(preference) : false;
}

/**
 * Did `value` change since the last time this scope rendered?
 *
 * Route changes remount the whole tree, so "did this component just mount" is
 * not the same question as "did the thing it represents just change". Without
 * this, the sidebar replayed its entrance on every sidebar-row click, because
 * a click navigates and a navigation remounts. The last value is kept at module
 * scope, which is what outlives the remount; the read is pure and the write
 * happens after commit, so a double render in StrictMode sees the same answer.
 */
const lastSeen = new Map<string, string>();

export function useSwitched(scope: string, value: string) {
  const previous = lastSeen.get(scope);
  const switched = previous !== undefined && previous !== value;
  useEffect(() => {
    lastSeen.set(scope, value);
  }, [scope, value]);
  return switched;
}

/** test seam: forget what every scope last saw */
export function __resetSwitched() {
  lastSeen.clear();
}

/** A timed transition, collapsed to an instant swap under reduced motion. */
export function timing(duration: number, reduce: Reduce, delay = 0) {
  if (reduce) return { duration: 0, delay: 0 };
  return { duration, ease: EASE, delay };
}

/** The shared-element spring, collapsed the same way. */
export function spring(reduce: Reduce) {
  return reduce ? { duration: 0 } : SPRING;
}

/**
 * A body that fades and travels: the sidebar under a rail switch, the content
 * pane under a route change, a thread opening.
 */
export const bodyVariants = {
  initial: { opacity: 0, y: SHIFT.body },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -SHIFT.body },
} as const;

/** A glyph swapping in place — no travel, so the label beside it cannot move. */
export const glyphVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const;

/** A message bubble arriving. */
export const popVariants = {
  initial: { opacity: 0, scale: POP_SCALE },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: POP_SCALE },
} as const;

/** A menu opening from its anchor corner. */
export const menuVariants = {
  initial: { opacity: 0, scale: MENU_SCALE },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: MENU_SCALE },
} as const;

/** A row appearing in or leaving a list. */
export const rowVariants = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: "auto" },
  exit: { opacity: 0, height: 0 },
} as const;

/** shared-element ids, so two components cannot disagree on the string */
export const LAYOUT_ID = {
  railPlate: "rail-active-plate",
  navPlate: "sidebar-active-plate",
} as const;
