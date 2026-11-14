import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SIDE_TAB_REACH, SideTabs } from "@/components/side-tabs";

describe("SideTabs", () => {
  it("renders four blank handles, hidden from assistive tech", () => {
    const { container } = render(<SideTabs />);
    const stack = container.querySelector("[data-side-tabs]") as HTMLElement;

    expect(stack.getAttribute("aria-hidden")).toBe("true");
    expect(stack.querySelectorAll("[data-side-tab]")).toHaveLength(4);
    // blank and inert: no words, nothing to tab to
    expect(stack.textContent).toBe("");
    expect(stack.querySelector("a, button, input, [tabindex]")).toBeNull();
  });

  it("is one pixel of card border plus the reach wide", () => {
    const { container } = render(<SideTabs />);
    const tab = container.querySelector("[data-side-tab]") as SVGSVGElement;

    expect(tab.getAttribute("width")).toBe(String(SIDE_TAB_REACH + 1));
  });
});
