import { describe, expect, it } from "vitest";

import {
  DURATION,
  EASE,
  EXIT_RATIO,
  LAYOUT_ID,
  MENU_SCALE,
  POP_SCALE,
  PRESS_SCALE,
  SHIFT,
  SPRING,
  bodyVariants,
  exitDuration,
  glyphVariants,
  menuVariants,
  popVariants,
  rowVariants,
  spring,
  timing,
} from "@/lib/motion-tokens";

/**
 * The motion is calibrated. These are the numbers the whole app animates on,
 * and every surface's own test asserts that it uses *these* rather than a
 * literal of its own.
 */
describe("motion tokens", () => {
  it("holds the three durations and the easing", () => {
    expect(DURATION.fast).toBe(0.09);
    expect(DURATION.base).toBe(0.12);
    expect(DURATION.move).toBe(0.18);
    expect(DURATION.section).toBe(0.16);
    expect(EASE).toEqual([0.32, 0.72, 0, 1]);
  });

  it("holds the shared-element spring", () => {
    expect(SPRING).toEqual({ type: "spring", stiffness: 500, damping: 40, mass: 0.8 });
  });

  it("runs exits at three quarters of the entrance", () => {
    expect(EXIT_RATIO).toBe(0.75);
    expect(exitDuration(DURATION.move)).toBeCloseTo(0.135, 5);
    expect(exitDuration(DURATION.base)).toBeCloseTo(0.09, 5);
  });

  it("holds the travel distances and scales", () => {
    expect(SHIFT.crumb).toBe(6);
    expect(SHIFT.body).toBe(8);
    expect(POP_SCALE).toBe(0.98);
    expect(MENU_SCALE).toBe(0.96);
    expect(PRESS_SCALE).toBe(0.96);
  });

  it("collapses every transition under reduced motion", () => {
    expect(timing(DURATION.move, false)).toEqual({ duration: 0.18, ease: EASE, delay: 0 });
    expect(timing(DURATION.move, false, 0.08)).toEqual({ duration: 0.18, ease: EASE, delay: 0.08 });
    // instant, and the delay goes too — a delayed instant swap is still a delay
    expect(timing(DURATION.move, true, 0.08)).toEqual({ duration: 0, delay: 0 });
    expect(spring(false)).toEqual(SPRING);
    expect(spring(true)).toEqual({ duration: 0 });
  });

  it("shapes the variants each surface shares", () => {
    expect(bodyVariants.initial).toEqual({ opacity: 0, y: SHIFT.body });
    expect(bodyVariants.exit).toEqual({ opacity: 0, y: -SHIFT.body });
    // a glyph swaps in place: no travel, or the label beside it would move
    expect(glyphVariants.animate).toEqual({ opacity: 1 });
    expect(Object.values(glyphVariants).every((v) => !("y" in v) && !("scale" in v))).toBe(true);
    expect(popVariants.initial).toEqual({ opacity: 0, scale: POP_SCALE });
    expect(menuVariants.initial).toEqual({ opacity: 0, scale: MENU_SCALE });
    expect(rowVariants.animate).toEqual({ opacity: 1, height: "auto" });
  });

  it("names the shared-element ids once", () => {
    expect(LAYOUT_ID.railPlate).toBe("rail-active-plate");
    expect(LAYOUT_ID.navPlate).toBe("sidebar-active-plate");
  });
});
