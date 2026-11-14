import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TopBar } from "@/components/top-bar";

/** the placeholder the switcher shows; see the note in top-bar.tsx */
const WORKSPACE_LABEL = "Workspace";

/**
 * Calibrated against reference/target-1440x900@2x.png — these assert the
 * measurements the pixel diff depends on, not incidental markup. If one of
 * them fails the strip diff has already regressed.
 */
describe("TopBar", () => {
  it("is a 40px page-bg bar with no bottom border of its own", () => {
    const { container } = render(<TopBar />);
    const bar = container.querySelector('[data-region="top-bar"]')!;

    expect(bar.className).toContain("h-10");
    expect(bar.className).toContain("bg-plane-page");
    // the y=40 line is drawn by the rail/sidebar and the content card (CONTRACT §1)
    expect(bar.className).not.toMatch(/border-b/);
  });

  it("centres a 364x28 search field with a magnifier and 'Search' placeholder", () => {
    const { container } = render(<TopBar />);
    const input = screen.getByPlaceholderText("Search");

    // x 538..902 (centred on 720), y 6..34, 1px #E1E2E3, radius 8
    expect(input.className).toContain("h-[28px]");
    expect(input.className).toContain("rounded-[8px]");
    expect(input.className).toContain("border-[#E1E2E3]");
    const field = input.parentElement!;
    expect(field.className).toContain("w-[364px]");
    expect(field.className).toContain("left-1/2");
    expect(container.querySelector("svg.lucide-search")).not.toBeNull();
  });

  it("heads the bar with the workspace tile, its name and a chevron", () => {
    const { container } = render(<TopBar />);
    const sw = container.querySelector("[data-topbar-workspace]") as HTMLElement;

    // measured: tile x 18..44 y 7..33, name ink 52.5..172.5, chevron 180.5..189.5
    expect(sw.className).toContain("left-[18px]");
    expect(sw.className).toContain("h-10");

    // 26px tile, radius 6 — re-fitted against the reference's corner-inset
    // profile: 0.5px in at 3px down, flush by 4.5px down
    const tile = sw.querySelector("svg") as SVGElement;
    expect(tile.getAttribute("width")).toBe("26");
    const plate = tile.querySelector("rect") as SVGRectElement;
    expect(plate.getAttribute("rx")).toBe("6");
    // the ribbon is knocked out of the tile, not sat on it, so the tile is the
    // mark's own ink rather than Plane's --plane-brand blue
    expect(sw.querySelector(".bg-plane-brand")).toBeNull();
    expect(tile.querySelectorAll("path").length).toBeGreaterThan(0);

    const name = within(sw).getByText(WORKSPACE_LABEL);
    expect(name.className).toContain("text-[14px]");
    expect(name.className).toContain("font-medium");
    expect(name.className).toContain("ml-[8px]");
    expect(sw.querySelector("svg.lucide-chevron-down")).not.toBeNull();
  });

  it("leaves the switcher inert and keeps the right-hand cluster gone", () => {
    const { container } = render(<TopBar />);
    const bar = container.querySelector('[data-region="top-bar"]') as HTMLElement;

    // "Get started", inbox, help, "AI assistant" and the avatar, x 1124.5..1427
    for (const gone of ["Get started", "AI assistant"]) {
      expect(screen.queryByText(gone), gone).toBeNull();
    }
    expect(container.querySelector('[data-slot="avatar"]')).toBeNull();
    expect(container.querySelector("[data-focus-ring]")).toBeNull();

    // no menu behind the switcher yet, so it is a plain box: nothing in the
    // bar is focusable but the search field
    expect(within(bar).queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("button", { name: "Switch workspace" })).toBeNull();

    expect(within(bar).getByPlaceholderText("Search")).toBeTruthy();
  });
});
