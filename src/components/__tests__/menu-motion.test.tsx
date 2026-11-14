import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DURATION, EASE, exitDuration } from "@/lib/motion-tokens";

vi.mock("@/lib/motion-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/motion-tokens")>()),
  useReduced: () => reduceMotion(),
}));

const reduceMotion = vi.fn(() => false);

const openMenu = () => {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return document.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement;
};

/**
 * The menu is the one surface animated with CSS rather than Motion — Base UI
 * owns the popup's mount and unmount (see the note on DropdownMenuContent).
 * The numbers still come from the tokens, and that is what this pins.
 */
describe("menu motion", () => {
  it("opens on the base duration and the shared easing", () => {
    const popup = openMenu();
    expect(popup.style.animationDuration).toBe(`${DURATION.base * 1000}ms`);
    expect(popup.style.animationTimingFunction).toBe(`cubic-bezier(${EASE.join(",")})`);
    // 120ms open, 90ms close — the exit ratio, not a second literal
    expect(popup.style.getPropertyValue("--exit-duration")).toBe(
      `${exitDuration(DURATION.base) * 1000}ms`,
    );
    expect(exitDuration(DURATION.base) * 1000).toBe(90);
  });

  it("grows from the anchor corner rather than its own centre", () => {
    const popup = openMenu();
    // Base UI computes the corner from the placement; the popup uses it
    expect(popup.className).toContain("origin-(--transform-origin)");
    expect(popup.className).toContain("zoom-in-95");
  });

  it("collapses the duration to zero under reduced motion", () => {
    reduceMotion.mockReturnValue(true);
    expect(openMenu().style.animationDuration).toBe("0ms");
    reduceMotion.mockReturnValue(false);
  });
});
