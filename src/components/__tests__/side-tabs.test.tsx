import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SIDE_TAB_REACH, SideTabs } from "@/components/side-tabs";

/** every x coordinate an absolute-command path visits, in order */
function xs(d: string) {
  return [...d.matchAll(/[MLA]([^MLAZ]+)/g)].map((m) => {
    const nums = m[1].trim().split(/[\s,]+/).map(Number);
    return nums[nums.length - 2]; // the endpoint's x is always second to last
  });
}

describe("SideTabs", () => {
  it("renders four blank handles, hidden from assistive tech", () => {
    const { container } = render(<SideTabs />);
    const stack = container.querySelector("[data-side-tabs]") as HTMLElement;

    expect(stack.getAttribute("aria-hidden")).toBe("true");
    expect(stack.querySelectorAll("[data-side-tab]")).toHaveLength(4);
    // blank and inert: no words, nothing to tab to, nothing to catch a click
    expect(stack.textContent).toBe("");
    expect(stack.querySelector("a, button, input, [tabindex]")).toBeNull();
    expect(stack.className).toContain("pointer-events-none");
  });

  it("is the reach plus one pixel of card border wide", () => {
    const { container } = render(<SideTabs />);
    const tab = container.querySelector("[data-side-tab]") as SVGSVGElement;

    expect(tab.getAttribute("width")).toBe(String(SIDE_TAB_REACH + 1));
  });

  it("faces inward: based on the right-hand border, reaching left", () => {
    const { container } = render(<SideTabs />);
    const tab = container.querySelector("[data-side-tab]") as SVGSVGElement;
    const width = Number(tab.getAttribute("width"));
    const outline = tab.querySelector("path.fill-none") as SVGPathElement;
    const points = xs(outline.getAttribute("d") ?? "");

    // both flares end on the border's centre line, in the box's last column
    expect(points[0]).toBe(width - 0.5);
    expect(points[points.length - 1]).toBe(width - 0.5);
    // and the rounded end is all the way over in the first one
    expect(Math.min(...points)).toBe(0.5);
  });
});
