import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AiPane } from "@/components/ai/pane";
import {
  SIDE_PANEL_INSET,
  SIDE_TAB_LABELS,
  SIDE_TAB_REACH,
  SideTabs,
} from "@/components/side-tabs";

/* Instant motion: the tests pin what opens and closes, not the frames between. */
vi.mock("@/lib/motion-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/motion-tokens")>()),
  useReduced: () => true,
}));

/** every x coordinate an absolute-command path visits, in order */
function xs(d: string) {
  return [...d.matchAll(/[MLA]([^MLAZ]+)/g)].map((m) => {
    const nums = m[1].trim().split(/[\s,]+/).map(Number);
    return nums[nums.length - 2]; // the endpoint's x is always second to last
  });
}

const tab = (name: string) => screen.getByRole("button", { name });

describe("SideTabs", () => {
  it("renders the four named tabs in order, as closed toggles", () => {
    const { container } = render(<SideTabs />);
    const stack = container.querySelector("[data-side-tabs]") as HTMLElement;
    const tabs = within(stack).getAllByRole("button");

    expect(tabs.map((t) => t.textContent)).toEqual([
      "Knowledge base",
      "References",
      "World Labs",
      "Force graph",
    ]);
    expect(SIDE_TAB_LABELS).toHaveLength(4);
    expect(tabs.every((t) => t.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(screen.queryByRole("region")).toBeNull();
    // the gaps between tabs stay click-through to the chat
    expect(stack.className).toContain("pointer-events-none");
    expect(tabs[0].className).toContain("pointer-events-auto");
  });

  it("is the reach plus one pixel of card border wide", () => {
    const { container } = render(<SideTabs />);
    const svg = container.querySelector("[data-side-tab] svg") as SVGSVGElement;

    expect(svg.getAttribute("width")).toBe(String(SIDE_TAB_REACH + 1));
  });

  it("faces inward: based on the right-hand border, reaching left", () => {
    const { container } = render(<SideTabs />);
    const svg = container.querySelector("[data-side-tab] svg") as SVGSVGElement;
    const width = Number(svg.getAttribute("width"));
    const outline = svg.querySelector("path.fill-none") as SVGPathElement;
    const points = xs(outline.getAttribute("d") ?? "");

    // both flares end on the border's centre line, in the box's last column
    expect(points[0]).toBe(width - 0.5);
    expect(points[points.length - 1]).toBe(width - 0.5);
    // and the rounded end is all the way over in the first one
    expect(Math.min(...points)).toBe(0.5);
  });

  it.each(SIDE_TAB_LABELS)("opens and closes the %s panel from its tab", async (name) => {
    render(<SideTabs />);

    fireEvent.click(tab(name));

    const panel = screen.getByRole("region", { name });
    expect(tab(name).getAttribute("aria-expanded")).toBe("true");
    expect(tab(name).getAttribute("aria-controls")).toBe(panel.id);
    expect(within(panel).getByRole("heading", { name })).toBeTruthy();
    // the other three are gone: only the open tab is left to press
    expect(screen.getAllByRole("button").map((t) => t.textContent)).toEqual([name]);

    fireEvent.click(tab(name));

    expect(tab(name).getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
    expect(screen.getAllByRole("button").map((t) => t.textContent)).toEqual([
      ...SIDE_TAB_LABELS,
    ]);
  });

  it("closes on Escape", async () => {
    render(<SideTabs />);

    fireEvent.click(tab("References"));
    expect(screen.getByRole("region", { name: "References" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(tab("References").getAttribute("aria-expanded")).toBe("false");
  });

  it("makes room in the pane while a panel is open, and gives it back on close", () => {
    /* the shell's content column: the pane's card and the stack side by side */
    const { container } = render(
      <div data-testid="column">
        <AiPane />
        <SideTabs />
      </div>,
    );
    const column = screen.getByTestId("column");
    const body = container.querySelector('[data-ai="pane-body"]') as HTMLElement;
    const inset = () => column.style.getPropertyValue(SIDE_PANEL_INSET);

    // the thread, composer and cards lay out inside the inset; the strip does not
    expect(body.style.paddingRight).toBe(`var(${SIDE_PANEL_INSET}, 0px)`);
    expect(inset()).toBe("0px");

    fireEvent.click(tab("World Labs"));
    // the panel (320px here: jsdom has no layout to cap it) plus its riding tab
    expect(inset()).toBe(`${320 + SIDE_TAB_REACH}px`);

    fireEvent.click(tab("World Labs"));
    expect(inset()).toBe("0px");
  });
});
