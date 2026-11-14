import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AiHeader } from "@/components/ai/ai-header";

/**
 * The strip that stands where `<ListHeader/>` stands. Its whole job is to keep
 * that component's box and draw almost nothing in it, so the box is what is
 * asserted hardest: anything that moved here would move the pane below it.
 */
describe("AiHeader", () => {
  const strip = (title?: string) => {
    const { container } = render(<AiHeader title={title} />);
    return container.querySelector('[data-region="ai-header"]') as HTMLElement;
  };

  it("keeps the list header's 44px box, but not its bottom hairline", () => {
    const el = strip("Anything");
    // 44px either way, so the thread below still starts at y=85: the rule used
    // to live inside the border-box, so dropping it moved nothing
    expect(el.className).toContain("h-[44px]");
    expect(el.className).not.toMatch(/\bborder-b\b/);
    expect(el.className).toContain("bg-plane-pane");
    expect(el.className).toContain("shrink-0");
  });

  it("draws nothing at all on the home screen", () => {
    const el = strip();
    expect(el.dataset.state).toBe("home");
    expect(el.textContent).toBe("");
    expect(el.querySelector("button")).toBeNull();
    expect(el.querySelector("svg")).toBeNull();
  });

  it("shows the chat's title and a chevron as one inert control", () => {
    const el = strip("What do we still need for the trip?");
    expect(el.dataset.state).toBe("chat");

    const button = screen.getByRole("button");
    expect(button.dataset.ai).toBe("chat-title");
    expect(button.textContent).toContain("What do we still need for the trip?");
    // 14px / 500, ink — the breadcrumb leaf's weight, one step up in size
    expect(button.className).toContain("text-[14px]");
    expect(button.className).toContain("font-medium");
    expect(button.className).toContain("text-plane-ink");
    // a 16px muted chevron, and no menu behind it yet
    const chevron = button.querySelector("svg") as SVGElement;
    expect(chevron.getAttribute("class")).toContain("size-4");
    expect(chevron.getAttribute("class")).toContain("text-plane-muted");
    expect(button.getAttribute("aria-haspopup")).toBeNull();
  });

  it("lands the title's ink where the breadcrumb's did, at x=340", () => {
    // list-header.tsx pads the strip by 29px inside the card's inner left edge
    // at x=311. The Button recipe's own px-2.5 is taken back off with -ml-2.5,
    // so it is the text that sits on 340 and not the button's box.
    const el = strip("Anything");
    expect(el.className).toContain("pl-[29px]");
    const button = screen.getByRole("button");
    expect(button.className).toContain("-ml-2.5");
    expect(button.className).toContain("px-2.5");
  });

  it("truncates a long title rather than pushing the strip open", () => {
    strip("A conversation with a title far longer than the strip can hold in one line");
    const label = screen.getByRole("button").querySelector("span") as HTMLElement;
    expect(label.className).toContain("truncate");
    expect(screen.getByRole("button").className).toContain("max-w-[520px]");
  });
});
